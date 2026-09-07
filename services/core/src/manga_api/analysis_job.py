"""解析ジョブの中身（#70 第 4 段階）。

解析は「走査で入れ物を全部見つける → 1 つずつ目次を読む」の 2 段構えで、
数百 GB の蔵書では数分かかる。要求の中で最後まで走らせると、その間ずっと
空の画面が続き、受け付けられたのかどうかも分からない。そこで整理と同じ
ジョブにして、育っていく結果を ``result`` に書き足していく。

**ジョブにするのは、途中経過のためだけではない。** 解析は投入の中身が
変わるたびに走り直す。要求の中で走らせると、投入を編集し続けた分だけ
解析がスレッドプールに溜まり、画面が見ている経路まで詰まる。同期の関数は
接続が切れても止まらないので、流し込みでは解けない。ジョブなら
``JobStore._report`` が進捗を書くのと同じロックで ``JobCancelled`` を
投げるので、打ち切りが自然に効く。

経路（``POST /api/jobs/analyze``）は ``app.py``。ここに中身を置いてあるのは、
``app.py`` が既に長く、経路の定義でさらに膨らませないため。
"""

import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_core.input_expander import iter_inputs
from manga_core.toc_analyzer import AnalysisScan, PlannedBook, analyze_stream
from manga_core.volume_detector import ORIGIN_NONE

logger = logging.getLogger(__name__)

# 走査の途中で打ち切りを見に行く間隔（歩いたフォルダの数）。1 つごとに
# 見に行くと、ロックと確定（``JobStore._report``）が走査そのものより重くなる。
# ここが粗すぎると、打ち切ったのに蔵書を歩き続けるワーカーが溜まる
SCAN_CHECKPOINT_PATHS = 200

# 育っていく途中経過を書き直す間隔（秒）。この報告は「いままでに分かったこと」を
# まるごと JSON にして確定するので、入れ物 1 件ごとに書くと書き込み量が件数の
# 二乗になる（1 万件なら延べ 5000 万冊分）。画面は 1 件ずつ増えなくても、
# 目に見えて伸びていれば足りる
RESULT_WRITE_INTERVAL = 0.2


class AnalyzeRequest(BaseModel):
    """出来上がる本を実行前に調べる依頼"""

    archives: list[str] = Field(
        description="解析対象の絶対パス。フォルダを渡すと中を再帰的に辿る"
    )
    title: str = Field(default="", description="作品名")
    author: str = Field(default="", description="著者名")


class PlannedBookView(BaseModel):
    """実行すると 1 冊出来る、という予告。

    ``organized`` から下の 4 つは決して省かない（#73 第 2 段階）。``unreadable``
    と同じ理由で、省くと画面から「整理済みでない」のか「判定していない」のかを
    区別できない。判定を ``issues`` に混ぜないのは、``issues`` が画面で警告バッジに
    なり、状態を問題として見せてしまうため。

    ``volume_origin`` / ``volume_source_name`` も同じ理由で省かない。省くと
    「並び順で決めた」のか「まだ判定していない」のかを画面から区別できない。
    """

    source: str
    entry: str
    output_name: str
    volume: int | None = None
    # 巻数の根拠。``PlannedBook`` の同名の欄をそのまま写す（値の意味と、
    # 走らせて確かめた落とし穴はそちらに書いてある）。
    #
    # ``Literal`` にしないのは、``volume_detector`` に 5 個目の origin が足された
    # 瞬間、表示用のこの欄のせいで解析ジョブ全体が ``ValidationError`` で落ちる
    # ため。巻数の読み方を増やしただけで解析が全滅するのは、増やす側から見え
    # ない罠になる（``organized_reason`` と同じ扱い）。
    #
    # **画面はこの 2 欄から ``organized`` や ``issues`` を導いてはいけない。**
    # 逆も同じ。整理済みでありながら ``last-number`` になる本があり（``第000巻``。
    # 理由は ``PlannedBook`` 側）、``volume-uncertain`` は ``last-number`` の一部
    # にしか付かない。どれも別の判定で、たまたま多くの本で揃って見えるだけ。
    volume_origin: str = Field(
        default=ORIGIN_NONE,
        description=(
            "巻数をどこから読んだか。pattern（第3巻・vol.3 などの型）/ "
            "last-number（名前の最後の数字）/ position（名前から読めず並び順を"
            "当てはめた）/ none（読めなかった）のいずれか。利用者に見せる言葉では"
            "なく、画面が読み分けるための識別子"
        ),
    )
    volume_source_name: str = Field(
        default="",
        description=(
            "巻数を読み取った名前。position のときは名前を読んでいないので空。"
            "空かどうかではなく volume_origin で読み分けること"
        ),
    )
    issues: list[str] = Field(
        default_factory=list, description="実行前に利用者へ見せる印"
    )
    organized: bool = Field(
        default=False, description="この本は既に整理の出力そのものか"
    )
    author: str | None = Field(
        default=None, description="本の名前から読んだ著者名。読めなければ null"
    )
    title: str | None = Field(
        default=None, description="本の名前から読んだ作品名。読めなければ null"
    )
    organized_reason: str | None = Field(
        default=None,
        description=(
            "整理済みでない理由。multiple-books / not-zip / name-mismatch / "
            "pages-mismatch / extra-entries / folder-mismatch のいずれか"
        ),
    )


def analysis_work(
    targets: list[Path],
    author: str,
    title: str,
    is_allowed: Callable[[Path], bool],
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """解析ジョブの中身を組み立てる。

    ``targets`` は利用者が名指ししたパスで、許可の検証は投入の時点で済んで
    いる。その下を辿って見つけたものは名指しされていないので、1 件ずつ
    ``is_allowed`` に掛ける。**辿るのと落とすのは必ず一組で動かす。**
    離すと、許可された場所に置かれた「外を指すリンク」が解析の対象に戻る。
    """

    def work(report: ProgressReporter) -> dict[str, Any]:
        # 走査そのものをワーカーで行う。投入の応答の中で数百 GB を歩くと、
        # 受け付けられたことすら画面に返らない
        found = _scan(targets, is_allowed, report)

        containers: list[str] = []
        books: list[dict[str, Any]] = []
        unreadable: list[dict[str, str]] = []

        def snapshot() -> dict[str, Any]:
            """いまの時点までに分かったこと。

            4 つの鍵は常に揃える。``scanned`` を別に持つのは、``containers``
            が空のときに「走査がまだ終わっていない」と「1 件も見つからな
            かった」を画面から区別するため。``unreadable`` も鍵ごと省かない。
            省くと「読めなかったものが無い」のか「数えていない」のかが
            分からない。
            """
            return {
                "scanned": True,
                "containers": list(containers),
                "books": list(books),
                "unreadable": list(unreadable),
            }

        # 進捗の分母は入れ物の数、分子は目次を読み終えた数。本を数えると、
        # 走査が終わっても分母が決まらず、進捗が伸び縮みする
        read = 0
        # 途中経過を最後に書いた時刻。None は「まだ一度も書いていない」
        written: float | None = None
        # 目次読みの最中にも打ち切りを見に行く。切れ目（1 件返るごと）でしか
        # 見ないと、入れ子だらけの 1 冊を読んでいる数分は打ち切りが効かず、
        # しかもその打ち切りは ``unreadable`` の「目次を読めません」に化ける
        for event in analyze_stream(found, author, title, report):
            if isinstance(event, AnalysisScan):
                # 走査が終わった時点で入れ物を全部渡す。画面はここで行を
                # 並べ切ってしまい、あとは本が生えるだけになる
                containers = [str(path) for path in event.containers]
                report(current=0, total=len(containers), result=snapshot())
                continue

            read += 1
            books.extend(_book_view(book) for book in event.books)
            if event.error:
                unreadable.append(
                    {"source": str(event.container), "reason": event.error}
                )
            # 件数だけは 1 件ごとに進める。整数 2 つの書き換えなので軽く、
            # 間引くと進捗の分子が止まって見える。重いのは途中経過のほうで、
            # そちらは間隔を空ける。1 件目は必ず書く（画面が「解析が進んで
            # いる」と分かる最初の合図で、ここを間引くと空のまま待たされる）
            now = time.monotonic()
            growing = written is None or now - written >= RESULT_WRITE_INTERVAL
            # 読めたものには経過を残さない。1 万件のアーカイブで 1 行ずつ
            # 出すと、上限を溢れて本当に困っている報告が流れて消える
            report(
                current=read,
                total=len(containers),
                message=_failure_line(event.container, event.error),
                result=snapshot() if growing else None,
            )
            if growing:
                written = now

        # 最後の 1 件は間引かれているかもしれない。終わりの形は必ず全部を返す
        return snapshot()

    return work


def _scan(
    targets: list[Path],
    is_allowed: Callable[[Path], bool],
    report: ProgressReporter,
) -> list[Path]:
    """投入されたパスの下を歩き、許可された入れ物だけを拾う。

    **辿るのと落とすのは必ず一組。** 1 つの式にしてあるのは、離すと許可された
    場所に置かれた「外を指すリンク」が解析の対象に戻るため。

    歩いている最中も折々で ``report`` を呼ぶ。欄は 1 つも書き換えない報告だが、
    打ち切られていればここで ``JobCancelled`` が上がる。歩き切ってから初めて
    見に行くのでは、数百 GB の蔵書で数分のあいだ打ち切りが効かない。
    """
    walked = 0

    def checkpoint() -> None:
        nonlocal walked
        walked += 1
        if walked % SCAN_CHECKPOINT_PATHS == 0:
            report()

    return [path for path in iter_inputs(targets, checkpoint) if is_allowed(path)]


def _failure_line(container: Path, error: str | None) -> str:
    """読めなかったことを経過に残す 1 行。読めたときは空。

    進捗の message は次の報告で上書きされるので、ポーリングの間隔次第では
    見落とす。どのアーカイブだったかが後から分かるよう、名前を入れる。
    """
    if error is None:
        return ""
    return f"目次を読めませんでした: {container.name}（{error}）"


def _book_view(book: PlannedBook) -> dict[str, Any]:
    """本 1 冊を、画面へ渡す形にする"""
    return PlannedBookView(
        source=str(book.source),
        entry=book.entry,
        output_name=book.output_name,
        volume=book.volume,
        volume_origin=book.volume_origin,
        volume_source_name=book.volume_source_name,
        issues=list(book.issues),
        organized=book.organized,
        author=book.author,
        title=book.title,
        organized_reason=book.organized_reason,
    ).model_dump()
