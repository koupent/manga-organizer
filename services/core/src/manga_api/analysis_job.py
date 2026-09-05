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
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_core.input_expander import expand_inputs
from manga_core.toc_analyzer import AnalysisScan, PlannedBook, analyze_stream

logger = logging.getLogger(__name__)


class PlannedBookView(BaseModel):
    """実行すると 1 冊出来る、という予告"""

    source: str
    entry: str
    output_name: str
    volume: int | None = None
    issues: list[str] = Field(
        default_factory=list, description="実行前に利用者へ見せる印"
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
        found = [path for path in expand_inputs(targets) if is_allowed(path)]

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
        for event in analyze_stream(found, author, title):
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
            # 読めたものには経過を残さない。1 万件のアーカイブで 1 行ずつ
            # 出すと、上限を溢れて本当に困っている報告が流れて消える
            report(
                current=read,
                total=len(containers),
                message=_failure_line(event.container, event.error),
                result=snapshot(),
            )

        return snapshot()

    return work


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
        issues=list(book.issues),
    ).model_dump()
