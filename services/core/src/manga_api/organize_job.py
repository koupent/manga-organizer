"""アーカイブを整理するジョブの、依頼の形と中身（#70）。

整理は数百 GB の蔵書を 1 冊ずつ書き出すので、要求の中では終わらない。
解析が予告した本のうち利用者が選んだものだけを作る、という絞り込みも
ここが持つ。予告（``analysis_job``）と実行（ここ）で本の指し方が食い違うと、
画面で外したはずの本が出来上がる。

経路（``POST /api/jobs/organize``）は ``app.py``。

``locate_books`` はモジュールの読み込み時に束ねる。``toc_analyzer`` 越しに
呼ぶ形に変えると、解析のテストが ``mock.patch.object(toc_analyzer, ...)`` で
差し替えたものがここまで効いてしまい、整理の側の振る舞いが解析のテストに
引きずられる。
"""

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_core.toc_analyzer import locate_books

logger = logging.getLogger(__name__)


class BookRef(BaseModel):
    """本 1 冊の指定。

    名前ではなく「元のアーカイブ + その中での位置」で指す。出来上がる名前は
    作品名と著者で毎回変わるので、名前を鍵にすると入力欄をいじった瞬間に
    選択が外れる。``entry`` はアーカイブ全体が 1 冊なら空文字。
    """

    source: str = Field(description="元のアーカイブ（または画像フォルダ）の絶対パス")
    entry: str = Field(default="", description="アーカイブ内での位置")


class OrganizeRequest(BaseModel):
    """アーカイブ整理の依頼"""

    archives: list[str] = Field(
        description="整理対象の絶対パス。フォルダを渡すと中を再帰的に辿る"
    )
    output_directory: str = Field(description="出力先ディレクトリ")
    title: str = Field(default="", description="作品名")
    author: str = Field(default="", description="著者名")
    keep_originals: bool = Field(default=True, description="元ファイルを残すか")
    books: list[BookRef] | None = Field(
        default=None,
        description=(
            "作る本。省くと投入されたものを全部作る。"
            "与えると、その本だけを作る（空の配列は 1 冊も作らない）"
        ),
    )


def wanted_entries(books: list[BookRef] | None) -> dict[Path, set[str]] | None:
    """作る本を、元のアーカイブごとにまとめる。

    ``None``（指定なし）と空の辞書（1 冊も作らない）は別物なので、``books`` を
    省いたときだけ ``None`` を返す。パスはリンクを解いた形に揃える。解析が
    返した文字列と整理で辿り直したパスは、同じ物でも書き方が違いうる。
    """
    if books is None:
        return None
    wanted: dict[Path, set[str]] = {}
    for book in books:
        wanted.setdefault(Path(book.source).resolve(), set()).add(book.entry)
    return wanted


def organize_work(
    output_directory: Path,
    archives: list[Path],
    request: OrganizeRequest,
    wanted: dict[Path, set[str]] | None,
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """整理ジョブの中身を組み立てる。

    ``archives`` は投入の時点で許可と選択の両方を通したもの。``wanted`` は
    そのときに使った絞り込みをそのまま渡す。ここで求め直すと、進捗の総数を
    決めた絞り込みと、本を外す絞り込みが別々に決まることになる。
    """

    def work(report: ProgressReporter) -> dict[str, Any]:
        # 取り込みが重いので、整理を投入したときだけ読み込む
        from manga_core.file_organizer import FileOrganizer

        organizer = FileOrganizer(
            # 確かめたパスをそのまま渡す。文字列から組み直すと、確かめた
            # 場所と書き出す場所が別々に決まることになる
            output_directory=output_directory,
            keep_originals=request.keep_originals,
            log_callback=lambda message: report(message=message),
        )
        organizer.set_manga_info(author=request.author, title=request.title)
        produced: list[str] = []
        failed: list[dict[str, str]] = []
        for index, archive in enumerate(archives, 1):
            report(current=index, total=len(archives), message=archive.name)
            skip = _skipped_locations(archive, wanted)
            for result in organizer.process_single_archive(archive, skip):
                if result.success and result.output_path:
                    produced.append(str(result.output_path))
                    continue
                # process_single_archive() は処理中の例外を握りつぶして
                # success=False を返すので、ジョブは最後まで走り succeeded で
                # 終わる。ここで拾わないと「produced が空の成功」になり、
                # 全件失敗と「対象が 0 件だった」の区別が付かなくなる
                failed.append(
                    {
                        "archive": str(result.original_path),
                        "reason": result.error_message or "原因不明の失敗",
                    }
                )
        # 走り切ったこと（state）と、何が出来たか（result）は別に伝える。
        # failed はキーごと省かない。省くと画面から見て「失敗が無い」のか
        # 「失敗を数えていない」のかを区別できない
        return {"produced": produced, "failed": failed}

    return work


def _skipped_locations(
    archive: Path, wanted: dict[Path, set[str]] | None
) -> frozenset[str]:
    """このアーカイブの中で、作らない本の位置を求める。

    外すのは「解析で予告できていて、かつ選ばれなかった」本だけにする。
    予告できなかったもの（RAR・壊れたアーカイブ・入れ子の RAR）を黙って
    落とすと、利用者が外したつもりのない本が何も言わずに消える。
    """
    if wanted is None:
        return frozenset()
    chosen = wanted.get(archive.resolve(), set())
    try:
        located = locate_books(archive)
    except Exception as error:  # noqa: BLE001 - 読めないなら 1 冊も外さない
        # 目次を読めなければ、外していい本を 1 つも特定できない。ここで
        # 落とすと壊れた 1 つのせいで整理そのものが失敗する。読めなかった
        # ことは解析が先に印として出しているので、黙って消えることはない
        logger.warning("外す本を決められませんでした: %s (%s)", archive, error)
        return frozenset()
    return frozenset(
        location.extracted_path for location in located if location.entry not in chosen
    )
