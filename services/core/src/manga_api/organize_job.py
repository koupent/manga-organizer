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
from collections.abc import Callable, Hashable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel, Field, model_validator

from manga_api.analysis_job import file_size
from manga_api.jobs import ProgressReporter
from manga_core.cancellation import OperationCancelled
from manga_core.file_identity import file_key
from manga_core.organized_detector import judge_organized
from manga_core.toc_analyzer import locate_books
from manga_core.volume_detector import SeriesName

logger = logging.getLogger(__name__)

# 巻数の訂正が 1 つも無いときの地図。書き換えられない物を使い回すのは、
# 空の辞書を返す場所が増えたときに、片方の呼び出しが書き足した訂正が
# 別の呼び出しへ漏れるのを形の上で不可能にするため
_NO_CORRECTIONS: Mapping[str, int | None] = MappingProxyType({})


def source_key(source: str | Path) -> Hashable:
    """依頼が指す元のアーカイブの鍵。同じファイルの別の綴りは同じ鍵になる。

    名前を載せてよいかを見るときと、作る本をまとめるときで別々に鍵を作ると、
    同じファイルを別の書き方で 2 回指した依頼が、検証は素通りして名前だけ
    取り違える形で通る。鍵の作り方は 1 か所にしか置かない。

    綴りの違いを畳むのは ``file_key``（投入の展開と共有する）。パスの形で
    比べると、片方の綴りに名前・もう片方に訂正を載せた依頼が門を素通りする。
    依頼の文字列と、整理が辿り直した ``Path`` の両方を受ける。ここが受けないと
    呼び出し側が ``str`` へ直して渡すことになり、鍵の作り方が散らばる。
    """
    return file_key(source)


class VolumeOverride(BaseModel):
    """利用者が直した巻数（#114 段階 C）。

    巻数だけを ``int | None`` で受けず、包みにするのは ``None`` に 2 つの意味が
    乗るから。「まだ訂正していない」と「巻数を外す」が同じ ``null`` になり、
    後から見分けられない。画面（``plan.ts`` の ``selectedBooks``）は既に
    **全行へ** ``title`` / ``author`` の ``null`` を載せて送っているので、同じ
    書き方を ``volume`` にも広げると、既定の依頼が「全冊の巻数を消す」依頼に
    なる。包みの有無が「訂正したかどうか」で、中の ``number`` が「何巻か」。

    ``number`` に既定値は付けない。``{"volume": {}}`` を黙って「巻数なし」と
    読むと、包んだ意味そのものが消える。

    下限が 0 なのは体裁の話ではなく、往復するかどうかの話（実測）。``-1`` は
    ``[著者] 作品 第-01巻.zip`` になり、``organized_detector._ORGANIZED_STEM``
    （``第(?P<volume>\\d+)巻``）に**一致しない**。つまりその本は二度と
    「整理済み」にならず、投入するたびに永久に作り直される。しかも同じ名前は
    ``VolumeDetector`` の ``第(\\d+)巻`` に拾われて**第 1 巻として読み戻される**
    ので、利用者は「-1 巻にしたはずの本が 1 巻になっている」ものを受け取り
    続ける。``0`` は ``第000巻.zip`` になり 0 へ読み戻るので許す。
    """

    number: int | None = Field(
        ge=0,
        description="訂正後の巻数。null は「巻数を付けない」。省略はできない",
    )


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
    volume: VolumeOverride | None = Field(
        default=None,
        description=(
            "巻数の訂正。省くと自動判定のまま。"
            "包みの有無が「訂正したかどうか」で、中の number が「何巻か」"
        ),
    )
    suffix: int | None = Field(
        default=None,
        ge=1,
        description=(
            "名前に足す番号（_1 なら 1）。同じ巻を複数作るとき、画面が選んだ順に"
            "決める。省くと、出力先で空いている名前を前から使う"
        ),
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
        entries: dict[Hashable, set[str]] = {}
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

    @model_validator(mode="after")
    def _corrections_stay_off_books_that_carry_their_own_name(
        self,
    ) -> "OrganizeRequest":
        """巻数の訂正を載せてよい所を、ジョブになる前に決める（#114 段階 C）。

        上の ``_names_belong_to_a_whole_archive`` には混ぜない。あちらが決めて
        いるのは「名前を載せてよい所」という別の契約で、一緒にすると片方を
        直したときにもう片方の理由まで動く。

        断るのは 2 つだけ。

        1. 自分の名前を載せた本への訂正。名前が載っている本は、その名前のまま
           書き出される。**理由に「整理済みなので」とは書かない。** この時点で
           サイドカーは整理済みかどうかを知らない（知るにはアーカイブを開く
           しかない）ので、名前だけを載せた未整理の本にも同じ嘘が出る
        2. 同じ 1 冊に**違う**巻数が 2 つ。どちらが利用者の意図か決めようが
           ない。**同じ値なら通す。** 利用者がフォルダとその中のアーカイブを
           両方投入すると、同じ ``source`` と ``entry`` の行が 2 つ出来る

        1 は**行の中だけを見ても足りない**。同じ本を 2 行に分け、片方に名前、
        もう片方に訂正を載せると、行ごとの検査は素通りする。そのあと
        ``wanted_books`` が名前と訂正を 1 冊へ**再結合する**ので、断ったはずの
        訂正がそのまま効く。だから位置ごとに全行をまとめてから見る。まとめ方
        （``source_key``）は ``wanted_books`` と揃える。片方だけ正規化すると、
        門と実処理が別の本を指す。

        整理済みの本を守り切るのはここではない。名前欄を落として ``volume``
        だけ送る依頼はここを素通りするので、実行時の門（``_archive_plan``）が
        要る。
        """
        if self.books is None:
            return self
        named = {
            (source_key(book.source), book.entry)
            for book in self.books
            if book.title is not None or book.author is not None
        }
        numbers: dict[tuple[Hashable, str], set[int | None]] = {}
        for book in self.books:
            if book.volume is None:
                continue
            place = (source_key(book.source), book.entry)
            if place in named:
                raise ValueError(
                    "自分の名前を持つ本の巻数は訂正できません"
                    f"（その名前のまま書き出されます）: {book.source}"
                )
            found = numbers.setdefault(place, set())
            found.add(book.volume.number)
            if len(found) > 1:
                raise ValueError(f"同じ本に違う巻数が指定されています: {book.source}")
        return self


@dataclass(frozen=True)
class _Wanted:
    """1 つのアーカイブについて、作る本の位置と、その本自身の名前と、巻数の訂正"""

    entries: frozenset[str]
    series: SeriesName | None
    # 位置（``entry``） -> 訂正後の巻数。**鍵の有無が「訂正したかどうか」**で、
    # 値の ``None`` は「巻数を付けない」という正当な訂正。値の側で見分けようと
    # すると、巻数を外す依頼が自動判定の番号へ静かに戻る。既定値は付けない。
    # 訂正が 1 つも無い形（``_NO_CORRECTIONS``）を組み立て側に必ず書かせる
    volumes: Mapping[str, int | None]
    # 位置（``entry``） -> 名前に足す番号（#166）。番号の無い本は載せない
    suffixes: Mapping[str, int]


def wanted_books(books: list[BookRef] | None) -> dict[Hashable, _Wanted] | None:
    """作る本を、元のアーカイブごとにまとめる。

    ``None``（指定なし）と空の辞書（1 冊も作らない）は別物なので、``books`` を
    省いたときだけ ``None`` を返す。鍵は ``source_key``――**パスの形ではなく
    実体**――で作る。解析が返した文字列と整理で辿り直したパスは、同じ物でも
    書き方が違いうるし、同じファイルを 2 通りに綴った依頼も届く。

    位置と名前と巻数の訂正を 1 つの表に載せる。別々の表にして片方だけ生のパスで
    引くと、外す方は効いているのに名前や訂正だけが黙って落ちる。綴りの違いが
    起きない場所（テストの一時領域）では、それが誰にも見えない。
    """
    if books is None:
        return None
    entries: dict[Hashable, set[str]] = {}
    series: dict[Hashable, SeriesName] = {}
    volumes: dict[Hashable, dict[str, int | None]] = {}
    suffixes: dict[Hashable, dict[str, int]] = {}
    for book in books:
        key = source_key(book.source)
        entries.setdefault(key, set()).add(book.entry)
        own = book.own_series()
        if own is not None:
            series[key] = own
        if book.volume is not None:
            # 同じ本に違う巻数が 2 つ載った依頼は ``OrganizeRequest`` が既に
            # 断っている。ここへ来る重複は同じ値なので、上書きしても変わらない
            volumes.setdefault(key, {})[book.entry] = book.volume.number
        if book.suffix is not None:
            suffixes.setdefault(key, {})[book.entry] = book.suffix
    return {
        key: _Wanted(
            entries=frozenset(found),
            series=series.get(key),
            volumes=MappingProxyType(volumes.get(key, {})),
            suffixes=MappingProxyType(suffixes.get(key, {})),
        )
        for key, found in entries.items()
    }


def organize_work(
    output_directory: Path,
    archives: list[Path],
    request: OrganizeRequest,
    wanted: dict[Hashable, _Wanted] | None,
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """整理ジョブの中身を組み立てる。

    ``archives`` は投入の時点で許可と選択の両方を通したもの。``wanted`` は
    そのときに使った絞り込みをそのまま渡す。ここで求め直すと、進捗の総数を
    決めた絞り込みと、本を外す絞り込みが別々に決まることになる。
    """

    def work(report: ProgressReporter) -> dict[str, Any]:
        # 取り込みが重いので、整理を投入したときだけ読み込む
        from manga_core.file_organizer import BookDone, FileOrganizer, ProcessResult

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
        refused: list[dict[str, str]] = []
        # 進捗は作る本の冊数で数える（#159）。入れ物の数で数えると、何十冊も
        # 入ったアーカイブ 1 つでは、始めた瞬間から終わるまで 1 / 1 のまま動かない
        planned = [_planned_books(archive, wanted) for archive in archives]
        total = sum(planned)
        done = 0
        # 出来た本と、それが一覧のどの行か（#160）。全部済むのを待たずに途中の
        # 結果として返し、画面は出来た本の行から編集へ移れるようにする
        finished: list[dict[str, Any]] = []

        def advance(to: int = 0, message: str = "") -> None:
            # 予告より多く出来たら、総数のほうを伸ばす。100% を超えさせない
            nonlocal done
            done = max(done, to)
            report(
                current=done,
                total=max(total, done),
                message=message,
                result={"finished": list(finished)},
            )

        def made_in(archive: Path, plan: _ArchivePlan) -> BookDone:
            def tell(result: ProcessResult, location: str | None) -> None:
                entry = plan.entries.get(location) if location is not None else None
                if result.success and result.output_path and entry is not None:
                    finished.append(
                        {
                            "source": str(archive),
                            "entry": entry,
                            "path": str(result.output_path),
                            "size": file_size(result.output_path),
                        }
                    )
                advance(done + 1)

            return tell

        for index, archive in enumerate(archives):
            # 前の入れ物の予定冊数までは済んだことにする。作り直すまでもなかった本や
            # 入れ物ごと失敗した本のぶんが、いつまでも残らないように
            advance(sum(planned[:index]), archive.name)
            series = _series_for(archive, request, wanted)
            if not series.author or not series.title:
                failed.append(_nameless_failure(archive))
                continue
            # 外す本を数えるのに 1 冊分の入れ子を全部読む。解析と同じ検査点を
            # 渡さないと、打ち切りが効くのは読み切ったあとの最初のログ行に
            # なり、数百 GB の入れ子を抱えた 1 冊ではそこまで丸ごと無駄になる
            plan = _archive_plan(archive, wanted, report)
            refused.extend(_announce(plan.refused, report))
            for result in organizer.process_single_archive(
                archive,
                plan.skip,
                series,
                plan.volumes,
                made_in(archive, plan),
                suffixes=plan.suffixes,
            ):
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
        advance(total)
        # 走り切ったこと（state）と、何が出来たか（result）は別に伝える。
        # failed も refused もキーごと省かない。省くと画面から見て「無い」のか
        # 「数えていない」のかを区別できない
        return {
            "produced": produced,
            "failed": failed,
            "refused": refused,
            "finished": finished,
        }

    return work


def _announce(
    refusals: tuple[dict[str, str], ...], report: ProgressReporter
) -> tuple[dict[str, str], ...]:
    """断った訂正を残る所へ流し、そのまま返す（#114 段階 C）。

    黙って落とすのは禁止。利用者から見た症状が「直したのに直らない」だけに
    なり、依頼が届かなかったのか断られたのかを切り分ける手がかりが無くなる。
    跡は 3 つ――ジョブの結果（返した物を呼び出し側が積む）、``report`` が
    ``job_logs`` へ積むログ 1 行（``OrganizePanel.tsx`` がそのまま読む）、
    そして ``logger.warning``。1 つでも欠けると、画面と運用のどちらかから
    断ったことが見えなくなる。

    ``failed`` には混ぜない。あちらは「失敗した本」として画面に並ぶが、訂正を
    断られた本そのものは今までどおり作られる。
    """
    for item in refusals:
        report(message=item["reason"])
        logger.warning("巻数の訂正を断りました: %s", item)
    return refusals


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
    wanted: dict[Hashable, _Wanted] | None,
) -> SeriesName:
    """このアーカイブを書き出す名前を決める（#73 段階 4a）。

    整理済みの本は自分の名前を持っているので、それを使う。持たない本は
    いままでどおり依頼の対で作る。決め方をここ 1 か所に置くのは、名前を
    渡す側と「名前が無いから失敗させる」側が別々に決めると、片方が依頼の対へ
    落ちたまま、もう片方だけが失敗を報せることになるため。
    """
    found = wanted.get(source_key(archive)) if wanted is not None else None
    if found is not None and found.series is not None:
        return found.series
    return SeriesName(author=request.author, title=request.title)


@dataclass(frozen=True)
class _ArchivePlan:
    """1 つのアーカイブについて、目次を 1 回読んで決まること。

    ``skip`` と ``volumes`` は同じ鍵空間（``FileOrganizer._location_key`` が
    返す、展開ルートからの相対パス）を共有する。``refused`` は載っていた訂正の
    うち断ったもので、断られた本そのものは今までどおり作られる。
    """

    skip: frozenset[str]
    volumes: Mapping[str, int | None]
    refused: tuple[dict[str, str], ...]
    # 展開した位置 → 目次での位置（画面の行が持つ ``entry``）。出来た本が一覧の
    # どの行かを画面へ返すのに使う（#160）。目次を読めなければ空
    entries: Mapping[str, str]
    # 展開した位置 → 名前に足す番号（#166）。番号の無い本は載せない
    suffixes: Mapping[str, int]


_NO_SUFFIXES: Mapping[str, int] = MappingProxyType({})
_NOTHING_PLANNED = _ArchivePlan(
    frozenset(), _NO_CORRECTIONS, (), MappingProxyType({}), _NO_SUFFIXES
)


def _planned_books(archive: Path, wanted: dict[Hashable, _Wanted] | None) -> int:
    """このアーカイブから作る予定の冊数。進捗の総数に使う（#159）。

    選んだ本の指定が無ければ分からないので 1 冊と見込む。多く出来たときは
    進捗の側で総数を伸ばす。
    """
    found = wanted.get(source_key(archive)) if wanted is not None else None
    return len(found.entries) if found is not None else 1


def _archive_plan(
    archive: Path,
    wanted: dict[Hashable, _Wanted] | None,
    checkpoint: Callable[[], None],
) -> _ArchivePlan:
    """このアーカイブの中で、作らない本の位置と、位置ごとの巻数の訂正を求める。

    外すのは「解析で予告できていて、かつ選ばれなかった」本だけにする。
    予告できなかったもの（RAR・壊れたアーカイブ・入れ子の RAR）を黙って
    落とすと、利用者が外したつもりのない本が何も言わずに消える。

    **目次は 1 冊につき 1 回しか読まない。** 外す本を決めるのも、訂正の載った
    本が整理済みかどうかを見るのも、同じ ``locate_books`` の結果で足りる
    （``BookLocation`` は ``toc_names``――目次そのもの――を既に持っている）。
    2 回読むと、数百 GB の入れ子で目次読みが 2 倍になる。

    整理済みの本を守るのがここである理由は、それが実際にアーカイブを開かないと
    分からないため。依頼の**形**しか見ない門（``OrganizeRequest``）は、名前欄を
    落として ``volume`` だけ送る古い画面や台本を素通りさせる。整理済みの本は
    既にこの道具が作った物そのものなので、そこへ載った訂正を通すと、利用者は
    自分の蔵書の名前を静かに書き換えられる。

    **当て先の無い訂正は断りとして残す。** 訂正した位置がこのアーカイブに
    無ければ、適用も拒否もされないまま消える。黙って落とすと、利用者から見た
    症状は「直したのに直らない」だけになる。ZIP も画像フォルダも同じ扱い。

    ``checkpoint`` は解析（``analysis_job``）が渡すのと同じもの。整理だけ
    渡さずにおくと、同じ ``locate_books`` を呼ぶ 2 つの経路で打ち切りの
    効き方が食い違う。
    """
    if wanted is None:
        return _NOTHING_PLANNED
    found = wanted.get(source_key(archive))
    chosen = found.entries if found is not None else frozenset()
    corrections = found.volumes if found is not None else _NO_CORRECTIONS
    numbers = found.suffixes if found is not None else _NO_SUFFIXES

    if archive.is_dir():
        # 裸の画像フォルダは ``locate_books`` を通らない（``_reader_for`` が
        # 名前の拡張子で ``None`` を返す）。丸ごと 1 冊なので位置は空文字の
        # ままで鍵になり、外すかどうかは投入の時点で決まっている。この道具が
        # 書き出すのは ZIP だけなので、フォルダが整理済みになることも無い。
        # 当たるのは空文字だけ。それ以外の位置に載った訂正は当て先が無いので、
        # ZIP の側と同じ形で断る
        whole = (
            MappingProxyType({"": corrections[""]})
            if "" in corrections
            else _NO_CORRECTIONS
        )
        return _ArchivePlan(
            frozenset(),
            whole,
            _missing_refusals(archive, corrections, {""}),
            MappingProxyType({"": ""}),
            MappingProxyType({"": numbers[""]}) if "" in numbers else _NO_SUFFIXES,
        )

    try:
        located = locate_books(archive, checkpoint)
    except OperationCancelled:
        # 打ち切りは「目次を読めなかった」ではない。この行は下の
        # ``except Exception`` より必ず先に置く。食わせると、止めたのに
        # 1 冊も外さないまま書き出しへ進み、利用者は外したはずの本を受け取る
        raise
    except Exception as error:  # noqa: BLE001 - 読めないなら 1 冊も外さない
        # 目次を読めなければ、外していい本を 1 つも特定できない。ここで
        # 落とすと壊れた 1 つのせいで整理そのものが失敗する。読めなかった
        # ことは解析が先に印として出しているので、黙って消えることはない
        logger.warning("外す本を決められませんでした: %s (%s)", archive, error)
        # 訂正も当てる先が無い。黙って落とすと、利用者から見た症状は
        # 「直したのに直らない」だけになる
        return _ArchivePlan(
            frozenset(),
            _NO_CORRECTIONS,
            tuple(_unreadable_refusal(archive, entry) for entry in sorted(corrections)),
            MappingProxyType({}),
            _NO_SUFFIXES,
        )

    skip: set[str] = set()
    volumes: dict[str, int | None] = {}
    refused: list[dict[str, str]] = []
    seen: set[str] = set()
    for location in located:
        seen.add(location.entry)
        if location.entry not in chosen:
            skip.add(location.extracted_path)
            continue
        if location.entry not in corrections:
            continue
        # 目次はもう手元にある。整理済みかどうかを見るために、ファイルを
        # 1 バイトも読み直さない
        verdict = judge_organized(
            archive, location.entry, len(located), location.toc_names
        )
        if verdict.organized:
            refused.append(_organized_refusal(archive, location.entry))
            continue
        volumes[location.extracted_path] = corrections[location.entry]
    # 目次に一度も現れなかった位置への訂正は、当て先そのものが無い
    refused.extend(_missing_refusals(archive, corrections, seen))
    return _ArchivePlan(
        frozenset(skip),
        MappingProxyType(volumes),
        tuple(refused),
        MappingProxyType(
            {location.extracted_path: location.entry for location in located}
        ),
        MappingProxyType(
            {
                location.extracted_path: numbers[location.entry]
                for location in located
                if location.entry in chosen and location.entry in numbers
            }
        ),
    )


def _organized_refusal(archive: Path, entry: str) -> dict[str, str]:
    """整理済みの本に載っていた訂正を断ったこと（#114 段階 C）"""
    return _refusal(
        archive, entry, f"整理済みの本なので巻数の訂正は行いません: {archive.name}"
    )


def _missing_refusals(
    archive: Path, corrections: Mapping[str, int | None], seen: set[str]
) -> tuple[dict[str, str], ...]:
    """当て先が見つからなかった訂正を、断りとして残す（#114 段階 C）。

    適用も拒否もされなかった訂正を黙って落とすと、利用者から見た症状は
    「直したのに直らない」だけになり、依頼が届かなかったのか断られたのかを
    切り分ける手がかりが無くなる。依頼が間違っているとは限らない。解析の
    あとにアーカイブの中身が変われば起きる。

    ``seen`` はこのアーカイブで実際に在った位置。ZIP は目次に現れた位置、
    画像フォルダは丸ごと 1 冊を指す空文字だけ。
    """
    return tuple(
        _missing_refusal(archive, entry)
        for entry in sorted(corrections)
        if entry not in seen
    )


def _missing_refusal(archive: Path, entry: str) -> dict[str, str]:
    """訂正した位置がこのアーカイブに無かったこと（#114 段階 C）"""
    return _refusal(
        archive,
        entry,
        f"訂正した位置が見つからないので巻数の訂正は行いません: {archive.name}",
    )


def _unreadable_refusal(archive: Path, entry: str) -> dict[str, str]:
    """目次を読めず、訂正を当てる先が分からなかったこと（#114 段階 C）"""
    return _refusal(
        archive, entry, f"目次を読めないので巻数の訂正は行いません: {archive.name}"
    )


def _refusal(archive: Path, entry: str, reason: str) -> dict[str, str]:
    """断った訂正 1 件。

    理由には必ずファイル名を入れる。解析したときと実行したときで判定が食い違う
    ことはありうるので、どの本の話かが読めないと問い合わせに答えられない。

    ``failed`` には混ぜない。あちらは「失敗した本」として画面に並ぶが、訂正を
    断られた本そのものは今までどおり作られる。
    """
    return {"archive": str(archive), "entry": entry, "reason": reason}
