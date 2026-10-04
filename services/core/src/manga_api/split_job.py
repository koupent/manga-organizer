"""見開きを割る 2 つのジョブの中身（#58 段階 2）。

段階 1 の ``manga_core.page_splitter`` は「走査して行を組む」「行ぜんぶを
受け取って 1 回で書き直す」を持っている。画面はそれを直接は呼べない。走査は
数百枚の ZIP を 1 枚ずつ開くので要求の中では終わらず、確定は ZIP を丸ごと
書き直す。整理・解析と同じくジョブにして、受け付けだけを即返す。

**画面が送り返すのは意図だけ。** 名前と割る位置の 2 つきり。寸法も出どころも
受け取らない。受け取ると、画面が抱えている古い寸法で切られる余地が残る。
ZIP と同梱の記録だけを正とする。

**印（token）は、走査と確定の間に本が動いたことの検出。** 中央ディレクトリ
から読める名前と大きさだけで作るので安い。食い違えば投入を断る。ここが無いと、
別のタブで割った直後の古い画面から確定が通り、行が指す名前が別のページを
指したまま書き直される。

経路（``POST /api/jobs/split-scan`` と ``POST /api/jobs/split``）は ``app.py``。
ここに中身を置いてあるのは、``app.py`` が既に長く、経路の定義でさらに
膨らませないため（``analysis_job`` と同じ置き方）。
"""

import hashlib
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status
from pydantic import BaseModel, Field

from manga_api.jobs import ProgressReporter
from manga_api.thumbnails import ThumbnailCache
from manga_core.page_reorder import PageEntry, ZipPageEditor
from manga_core.page_splitter import (
    MergeIntent,
    SplitIntent,
    SplitPosition,
    SplitResult,
    SplitRow,
    apply_rows,
    scan_rows,
)

# 印の材料の先頭に書く版。作り方を変えたとき、古い画面が持っている印が
# 当たり続けないようにする
_TOKEN_VERSION = "2"


class SplitScanRequest(BaseModel):
    """見開きを割る画面を開くための走査の依頼"""

    archive: str = Field(description="対象アーカイブの絶対パス")


class SplitPositionView(BaseModel):
    """割る位置。行の width / height と同じ座標系で読む"""

    x: int


class SplitIntentRowView(BaseModel):
    """画面が送り返す 1 行。名前と割る位置（と結合するか）だけ。

    寸法や出どころは受け取らない。受け取ると、画面が抱えている古い寸法で
    切られる余地が残る。
    """

    names: list[str] = Field(
        description="この行が占める、いま存在するページ名（割った対は 2 つ）"
    )
    # 既定値を持たせない。持たせると生成される画面側の型で任意項目になり、
    # 「割らない」と「言い忘れた」を受け取る側が区別できなくなる
    split: SplitPositionView | None = Field(
        description="割る位置。割らない（割る前へ戻す）なら null"
    )
    merge: bool = Field(
        default=False,
        description=(
            "隣り合う 2 ページ（names の 2 つ）を 1 枚の見開きへ結合するか。"
            "split は null にする"
        ),
    )


class SplitConfirmRequest(BaseModel):
    """割った結果を書き込む依頼。行は差分ではなく全部を送る。

    確定は連番を振り直すので、どのみち ZIP を丸ごと書き直す。全部あれば
    「行の名前を並べたもの＝いまのページ順」をサイドカーが照合できる。
    """

    archive: str = Field(description="対象アーカイブの絶対パス")
    token: str = Field(description="走査が返した印")
    rows: list[SplitIntentRowView] = Field(description="ページ順に並べた行ぜんぶ")


class SplitRowView(BaseModel):
    """走査が返す 1 行。画面はこのまま並べる"""

    names: list[str]
    width: int
    height: int
    # 行の画素の出どころ。畳まれた行（"original"）は割る前の絵を
    # ``/api/original`` から、そうでない行は ``/api/image`` から引く
    source: str
    is_spread: bool
    # 既定値を持たせない。載せ忘れと「まだ割っていない」を、画面側が null で
    # 見分けられるようにする
    split: SplitPositionView | None
    displaced: bool = Field(
        description=(
            "割った対の 2 枚がいま隣り合っていないか。行は先に出てくる方の位置に"
            "置かれ、確定するとそこで 2 枚が隣り合う"
        )
    )
    kept_whole: bool = Field(
        description=(
            "見開きのまま残すと決めたページか（割ってから戻した・2 ページを結合した）。"
            "画面は①の「すべて分割」からこの行を外す"
        )
    )
    merge_suggested: bool = Field(
        description=(
            "この行と次の行の継ぎ目の色がつながっていて、2 枚で 1 枚の見開きらしいか。"
            "画面は結合の候補として示すだけで、保留にはしない"
        )
    )
    rejoin_suggested: bool = Field(
        description=(
            "割った対の 2 枚の継ぎ目の色がつながっていて、割る前の 1 枚に戻せば"
            "見開きらしいか。画面は結合の候補として示す"
        )
    )


class SplitScanView(BaseModel):
    """走査ジョブの結果"""

    archive: str
    page_count: int
    token: str
    rows: list[SplitRowView]


class SplitResultView(BaseModel):
    """確定ジョブの結果。

    数え方を 3 つに分けるのは、画面が「割った」「戻した」「位置を動かした」を
    言い分けるため。まとめると報告が嘘になる。
    """

    changed: bool
    page_count: int
    split_count: int
    restored_count: int
    adjusted_count: int
    joined_count: int = Field(
        description="離れていた対を、分割位置は変えずに隣り合わせへ戻した数"
    )
    merged_count: int = Field(
        description="隣り合う 2 ページを 1 枚の見開きへ結合した数"
    )


def archive_token(pages: Sequence[PageEntry]) -> str:
    """いま並んでいるページから、本の「印」を作る。

    名前だけでは足りない。ページは連番なので、別の本でも 001.png から
    始まる。名前しか見ない印だと、同じ枚数の 2 冊が同じ値になり、別の本を
    見ていた画面からの確定が通ってしまう。

    大きさだけでも足りない。同じ大きさに収まる別の絵に差し替えられると
    印が変わらず、別のタブで表紙を切った直後の画面からの確定が通り、
    **利用者が見ていないページが割られる**。中身まで見る必要がある。

    大きさ（展開後のバイト数）も CRC も中央ディレクトリに書いてあるので、
    画素は 1 枚も展開しない。ここで全ページを読み直す印にすると、確定の
    受け付けが走査と同じ時間かかる。

    名前の長さを先に書くのは、名前に区切り文字が入っていても混ざらない
    ようにするため。混ざると、中身の違う 2 冊が同じ印になりうる。
    """
    material = "\n".join(
        f"{page.crc}:{page.size}:{len(page.name)}:{page.name}" for page in pages
    )
    return hashlib.sha256(f"{_TOKEN_VERSION}\n{material}".encode()).hexdigest()


def refuse_stale_token(pages: Sequence[PageEntry], token: str) -> None:
    """走査したときから本が変わっていたら、投入の時点で断る。

    ジョブを作って失敗させるのではなく、その場で断る。作ってしまうと画面は
    受け付けられたと思い、割れたつもりで先へ進む。
    """
    if archive_token(pages) != token:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="走査したときからアーカイブが変わっています。開き直してください",
        )


def intent_rows(
    pages: Sequence[PageEntry], rows: Sequence[SplitIntentRowView]
) -> tuple[SplitIntent, ...]:
    """画面から届いた行を、コアが受け取る形へ落とす。

    落とす前に、行の名前を並べたものが今のページ順と 1 つも違わないことを
    確かめる。欠けている行を通すと、行を 1 つ作り損ねただけでページが消える。
    並びが違う行を通すと、割る画面を開いていた間に別のタブで動かした並びが
    黙って元へ戻る。並べ替えは別の経路の仕事。

    ただ 1 つ、割った対の 2 枚目だけは今の位置を離れてよい。走査は離れた対を
    1 枚目の位置へ畳むので（#133）、行の上では 2 枚目が 1 枚目の直後に来る。
    2 枚が本当に割った対かどうかは、コアが中身で確かめ直す。結合する 2 枚
    （#139）は離れてよい対に含めない。隣り合っていなければここで断る。
    """
    if any(row.merge and (len(row.names) != 2 or row.split) for row in rows):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="結合する行は、割る位置を持たない 2 ページでなければなりません",
        )
    submitted = [name for row in rows for name in row.names]
    current = _with_pairs_joined(
        [page.name for page in pages],
        {
            row.names[0]: row.names[1]
            for row in rows
            if len(row.names) == 2 and not row.merge
        },
    )
    if submitted != current:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="行の名前を並べたものが、いまのページ順と一致しません",
        )
    return tuple(_intent(row) for row in rows)


def _intent(row: SplitIntentRowView) -> SplitIntent | MergeIntent:
    """画面の 1 行を、コアの意図へ直す"""
    if row.merge:
        first, second = row.names
        return MergeIntent(names=(first, second))
    return SplitIntent(names=tuple(row.names), split=_position(row.split))


def _with_pairs_joined(order: list[str], partners: dict[str, str]) -> list[str]:
    """ページ順のうち、対の 2 枚目だけを 1 枚目の直後へ寄せた並び"""
    seconds = set(partners.values())
    joined: list[str] = []
    for name in order:
        if name in seconds:
            continue
        joined.append(name)
        if name in partners:
            joined.append(partners[name])
    return joined


def scan_work(path: Path) -> Callable[[ProgressReporter], dict[str, Any]]:
    """走査ジョブの中身を組み立てる"""

    def work(report: ProgressReporter) -> dict[str, Any]:
        # 印は走査より先に取る。走査の最中に別のタブが同じ本を書き換えると、
        # 行は書き換えの前後が混ざったものになる。後から取った印は「今の本」に
        # 当たってしまい、確定がその混ざった行を通す。先に取っておけば、
        # 確定のときに印が食い違って断られる
        token = archive_token(_pages_of(path))
        report(message="ページを読み取り中")
        rows = scan_rows(
            path,
            # 1 枚ごとに message を付けない。同じ 1 行がページ数だけ記録に
            # 積まれ、本当に伝えたい報告が上限からあふれて消える
            progress=lambda current, total: report(current=current, total=total),
        )
        return SplitScanView(
            archive=str(path),
            # 分母はページ数。割った対は 1 行に畳まれるので、行数とは一致しない
            page_count=sum(len(row.names) for row in rows),
            token=token,
            rows=[_row_view(row) for row in rows],
        ).model_dump()

    return work


def confirm_work(
    path: Path, rows: Sequence[SplitIntent | MergeIntent], thumbnails: ThumbnailCache
) -> Callable[[ProgressReporter], dict[str, Any]]:
    """確定ジョブの中身を組み立てる"""

    def work(report: ProgressReporter) -> dict[str, Any]:
        report(message="書き直し中")
        result = apply_rows(
            path,
            rows,
            progress=lambda current, total: report(current=current, total=total),
        )
        # 連番を振り直すので、002.jpg はもう別の絵。捨てないと、画面は
        # 同じ URL で割る前のサムネイルを並べ続ける
        thumbnails.discard(str(path))
        return _result_view(result).model_dump()

    return work


def _pages_of(path: Path) -> tuple[PageEntry, ...]:
    """いま並んでいるページを、中央ディレクトリだけ読んで取り出す"""
    editor = ZipPageEditor(path)
    try:
        return editor.pages
    finally:
        editor.close()


def _position(view: SplitPositionView | None) -> SplitPosition | None:
    """割る位置を、コアの形へ直す"""
    return None if view is None else SplitPosition(x=view.x)


def _row_view(row: SplitRow) -> SplitRowView:
    """走査が組んだ行 1 つを、画面へ渡す形にする"""
    return SplitRowView(
        names=list(row.names),
        width=row.width,
        height=row.height,
        source=row.source,
        is_spread=row.is_spread,
        split=None if row.split is None else SplitPositionView(x=row.split.x),
        displaced=row.displaced,
        kept_whole=row.kept_whole,
        merge_suggested=row.merge_suggested,
        rejoin_suggested=row.rejoin_suggested,
    )


def _result_view(result: SplitResult) -> SplitResultView:
    """確定の結果を、画面へ渡す形にする"""
    return SplitResultView(
        changed=result.changed,
        page_count=result.page_count,
        split_count=result.split_count,
        restored_count=result.restored_count,
        adjusted_count=result.adjusted_count,
        joined_count=result.joined_count,
        merged_count=result.merged_count,
    )
