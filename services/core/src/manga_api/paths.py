"""受け取ったパスを、許可された場所の中だけに閉じ込める。

守りは 1 つきり――**必ず ``resolve()`` してから許可の中かを見る**。許可の中に
置かれたリンクが外を指していると、名前のままでは中に見えて、開くと外を読む。
この判断が経路ごとに散ると、1 か所書き落とした経路だけが素通しになり、
しかもそれは読めてしまう経路を誰かが試すまで分からない。

そこで許可された場所と、それを使う入口を 1 つの物にまとめる。外から渡された
文字列がパスになる道はここを通るものだけ、という形にしておくための置き方。

書き出す先（``resolve_output_directory``）はここに入れない。読む側の許可とは
別に、この起動で利用者が選んだ場所（``ChosenOutputRoots``）も見るため。
混ぜると、出力先を選んだだけでその場所を読む入口まで開いてしまう。
"""

import logging
from pathlib import Path

from fastapi import HTTPException, status

from manga_core.input_expander import iter_inputs
from manga_core.page_reorder import PageReorderError, ZipPageEditor

logger = logging.getLogger(__name__)


class PathGuard:
    """許可された場所と、そこへ入るための入口をひとまとめにしたもの。

    ``roots`` が空なら制限しない。渡された一覧はそのまま持つ（``app.state``
    と同じ物を指す）ので、呼ぶ側が辿り直したうえで渡す。
    """

    def __init__(self, roots: list[Path]) -> None:
        self.roots = roots

    def within_allowed(self, path: Path) -> bool:
        """許可された場所に留まるかを見る。

        判定は必ず resolve() した後のパスで行う。許可の中に置かれたリンクが
        外を指していると、名前のままでは中に見えて、開くと外を読んでしまう。
        """
        roots = self.roots
        if not roots:
            return True
        return any(path.resolve().is_relative_to(root) for root in roots)

    def refuse_outside(self, path: Path) -> None:
        """許可の外なら、開く前に断る"""
        if not self.within_allowed(path):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="対象外のディレクトリです",
            )

    def resolve_archive(self, raw: str) -> Path:
        """受け取ったパスを検証して解決する"""
        path = Path(raw).resolve()
        self.refuse_outside(path)
        if not path.is_file():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        return path

    def resolve_organize_target(self, raw: str) -> Path:
        """整理の対象を検証して解決する。

        こちらはフォルダも受け付ける。利用者はアーカイブを 1 つずつ選ばず、
        フォルダごと投げ込むため（#70）。中身の展開は投入時に行う。
        """
        path = Path(raw).resolve()
        self.refuse_outside(path)
        if not path.exists():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="ファイルが見つかりません",
            )
        return path

    def expand_targets(self, raws: list[str]) -> list[Path]:
        """投入されたパスを、1 冊ずつの入力へ展開する。

        辿って見つけたものは利用者が名指ししていない。リンクで許可の外を
        指していないか、1 件ずつ確かめてから処理対象に入れる。

        検査は展開の**中へ**渡す。外で絞ると、展開が同じ実体の重複を落とし
        終えた後になり、許可の外を指すリンクが先に列挙されただけで許可の中の
        ハードリンクが消える（``input_expander.iter_inputs`` の ``accept``）。

        解析と整理で同じ展開を通すのは、処理順が同名衝突の ``_1`` の付き方を
        決めるため。片方だけ順番が変わると、予告した名前と実際に出来る名前が
        食い違う。
        """
        targets = [self.resolve_organize_target(raw) for raw in raws]
        return list(iter_inputs(targets, accept=self._accept_inside))

    def _accept_inside(self, found: Path) -> bool:
        """辿って見つけたものを処理対象にしてよいか。除いたものは記録に残す。

        検査が重複除去より前へ来たので、**警告は綴りごとに 1 行出る**。以前は
        実体で畳んだ後に書いていたため、外を指すリンクが何本あっても 1 行しか
        出ず、許可の中の実体が先に来た場合は 1 行も出なかった。蔵書にそのリンクが
        何本あるかは利用者が直したい事実なので、綴りごとに残す方を採る。
        サーバのログだけの変化で、API にもジョブのログにも出ない。
        """
        if self.within_allowed(found):
            return True
        logger.warning("許可された場所の外を指すため除きました: %s", found)
        return False

    def open_editor(self, raw: str) -> ZipPageEditor:
        """アーカイブを開く。開けない理由はそのまま伝える"""
        path = self.resolve_archive(raw)
        try:
            return ZipPageEditor(path)
        except PageReorderError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)
            ) from error
