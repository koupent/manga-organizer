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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, model_validator

from manga_api.jobs import ProgressReporter
from manga_core.toc_analyzer import locate_books
from manga_core.volume_detector import SeriesName

logger = logging.getLogger(__name__)


def source_key(source: str) -> Path:
    """元のアーカイブを指す鍵。リンクを解いた形に揃える。

    名前を載せてよいかを見るときと、作る本をまとめるときで別々に鍵を作ると、
    同じファイルを別の書き方で 2 回指した依頼が、検証は素通りして名前だけ
    取り違える形で通る。鍵の作り方は 1 か所にしか置かない。
    """
    return Path(source).resolve()


class BookRef(BaseModel):
    """本 1 冊の指定。

    名前ではなく「元のアーカイブ + その中での位置」で指す。出来上がる名前は
    作品名と著者で毎回変わるので、名前を鍵にすると入力欄をいじった瞬間に
    選択が外れる。``entry`` はアーカイブ全体が 1 冊なら空文字。
    """

    source: str = Field(description="元のアーカイブ（または画像フォルダ）の絶対パス")
    entry: str = Field(default="", description="アーカイブ内での位置")
    title: str | None = Field(
        default=None,
        description="この本自身の作品名。整理済みの本だけが持つ。省くと依頼の値を使う",
    )
    author: str | None = Field(
        default=None,
        description="この本自身の著者名。整理済みの本だけが持つ。省くと依頼の値を使う",
    )

    def own_series(self) -> SeriesName | None:
        """この本自身の名前。持っていなければ ``None``"""
        if self.title is None or self.author is None:
            return None
        return SeriesName(author=self.author, title=self.title)


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

    @model_validator(mode="after")
    def _names_belong_to_a_whole_archive(self) -> "OrganizeRequest":
        """本ごとの名前を載せてよい所を、ジョブになる前に決める（#73 段階 4a）。

        名前が指すのは**アーカイブ 1 つ**。整理済みと判定されるのは「1 冊だけを
        出し、その位置が空である入れ物」だけなので、それ以外に名前が載っていたら
        画面とサイドカーの理解が食い違っている。黙って無視すると、合本の 1 冊に
        載った名前でアーカイブ全体が作られ、症状は「ファイル名がおかしい」だけに
        なる。名前の半分（作品名だけ・著者だけ）も断る。無視すれば別の名前の
        ファイルが出来るだけで、利用者にはどこで取り違えたのか分からない。

        位置の数で見るのは、同じ本が依頼に 2 回載ることがあるため。利用者が
        フォルダとその中のアーカイブを両方投入すると、同じ本の行が 2 つ出来て
        同じ ``source`` と ``entry`` が並ぶ。これは取り違えではないので断らない。
        """
        if self.books is None:
            return self
        entries: dict[Path, set[str]] = {}
        for book in self.books:
            entries.setdefault(source_key(book.source), set()).add(book.entry)
        for book in self.books:
            if book.title is None and book.author is None:
                continue
            if book.title is None or book.author is None:
                raise ValueError(
                    f"本の名前は作品名と著者の両方が要ります: {book.source}"
                )
            if book.entry != "" or len(entries[source_key(book.source)]) > 1:
                raise ValueError(
                    "本の名前を載せられるのは、丸ごと 1 冊のアーカイブだけです: "
                    f"{book.source}"
                )
        return self


@dataclass(frozen=True)
class _Wanted:
    """1 つのアーカイブについて、作る本の位置と、その本自身の名前"""

    entries: frozenset[str]
    series: SeriesName | None


def wanted_books(books: list[BookRef] | None) -> dict[Path, _Wanted] | None:
    """作る本を、元のアーカイブごとにまとめる。

    ``None``（指定なし）と空の辞書（1 冊も作らない）は別物なので、``books`` を
    省いたときだけ ``None`` を返す。パスはリンクを解いた形に揃える。解析が
    返した文字列と整理で辿り直したパスは、同じ物でも書き方が違いうる。

    位置と名前を 1 つの表に載せる。別々の表にして片方だけ生のパスで引くと、
    外す方は効いているのに名前だけが黙って依頼の対へ落ちる。リンクを解いた形と
    生の形が一致する場所（テストの一時領域）では、それが誰にも見えない。
    """
    if books is None:
        return None
    entries: dict[Path, set[str]] = {}
    series: dict[Path, SeriesName] = {}
    for book in books:
        key = source_key(book.source)
        entries.setdefault(key, set()).add(book.entry)
        own = book.own_series()
        if own is not None:
            series[key] = own
    return {
        key: _Wanted(entries=frozenset(found), series=series.get(key))
        for key, found in entries.items()
    }


def organize_work(
    output_directory: Path,
    archives: list[Path],
    request: OrganizeRequest,
    wanted: dict[Path, _Wanted] | None,
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
        # 依頼の対は、自分の名前を持たない本の受け皿。実際にどちらの対で
        # 書き出すかは 1 冊ごとに _series_for が決める
        organizer.set_manga_info(author=request.author, title=request.title)
        produced: list[str] = []
        failed: list[dict[str, str]] = []
        for index, archive in enumerate(archives, 1):
            report(current=index, total=len(archives), message=archive.name)
            series = _series_for(archive, request, wanted)
            if not series.author or not series.title:
                failed.append(_nameless_failure(archive))
                continue
            skip = _skipped_locations(archive, wanted)
            for result in organizer.process_single_archive(archive, skip, series):
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


def _nameless_failure(archive: Path) -> dict[str, str]:
    """名前を 1 つも決められなかった本の失敗（#73 段階 4a）。

    自分の名前も依頼の対も無いまま書き出すと ``[] /[]  第009巻.zip`` が出来る。
    しかもそれは成功として並ぶので、利用者は失敗したことに気づけないまま、
    どこにも属さない本を抱える。1 冊のせいで実行全体は止めない。名前のある本は
    作れるので、止めると作れた本まで見えなくなる。
    """
    return {
        "archive": str(archive),
        "reason": f"作品名と著者名が分からないので整理できません: {archive.name}",
    }


def _series_for(
    archive: Path,
    request: OrganizeRequest,
    wanted: dict[Path, _Wanted] | None,
) -> SeriesName:
    """このアーカイブを書き出す名前を決める（#73 段階 4a）。

    整理済みの本は自分の名前を持っているので、それを使う。持たない本は
    いままでどおり依頼の対で作る。決め方をここ 1 か所に置くのは、名前を
    渡す側と「名前が無いから失敗させる」側が別々に決めると、片方が依頼の対へ
    落ちたまま、もう片方だけが失敗を報せることになるため。
    """
    found = wanted.get(archive.resolve()) if wanted is not None else None
    if found is not None and found.series is not None:
        return found.series
    return SeriesName(author=request.author, title=request.title)


def _skipped_locations(
    archive: Path, wanted: dict[Path, _Wanted] | None
) -> frozenset[str]:
    """このアーカイブの中で、作らない本の位置を求める。

    外すのは「解析で予告できていて、かつ選ばれなかった」本だけにする。
    予告できなかったもの（RAR・壊れたアーカイブ・入れ子の RAR）を黙って
    落とすと、利用者が外したつもりのない本が何も言わずに消える。
    """
    if wanted is None:
        return frozenset()
    found = wanted.get(archive.resolve())
    chosen = found.entries if found is not None else frozenset()
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
