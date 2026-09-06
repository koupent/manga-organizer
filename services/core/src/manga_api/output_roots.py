"""利用者が出力先として選んだ場所の覚え。

読む側（/api/browse や archive を受け取る経路）は最初から allowed_roots の
中に閉じている。書き出す側の出力先だけは、そこに閉じられない。蔵書は 2 台目の
ドライブや NAS に置かれることが多く、出力先の入力欄は自由入力なので、ホーム
以下へ縛ると D:\\manga へ整理できている利用者を丸ごと締め出してしまう。

代わりに、利用者が選んだ出力先をその時点で覚え、覚えのある場所へだけ書き出す。
境界は「ホームの中だけ」ではなく「利用者が選んだ場所だけ」になる。覚えるのは
`POST /api/output-roots` で名指しされたときだけで、整理の依頼そのものに載って
きた出力先は「選ばれた」ことにしない。1 回の依頼が出力先と、その許可を同時に
連れてくるなら、塞ごうとしている「どこへでも書ける」がそのまま残る。

覚えはこのオブジェクト（= 起動しているサイドカー）の中だけに置く。ディスクへ
残すと次の起動でも許可されたままになり、トークンを起動ごとに捨てている意味が
薄れる。読む側の許可（allowed_roots）とは決して混ぜない。混ぜると、書き出しの
穴を塞ぐ代わりに、その場所を読む入口を新しく開くことになる。
"""

import threading
from pathlib import Path


class ChosenOutputRoots:
    """この起動で選ばれた出力先を覚え、配下かどうかを答える"""

    def __init__(self) -> None:
        # 選ぶ操作は入力欄が変わるたびに届くので、続けて 2 つが重なりうる。
        # 組み立て直しの途中で重なると片方の覚えが落ち、利用者から見ると
        # 「選んだのに断られる」になる
        self._lock = threading.Lock()
        self._roots: tuple[Path, ...] = ()

    def remember(self, directory: Path) -> Path:
        """選ばれた場所を覚え、覚えた形（辿り直した絶対パス）を返す。

        まだ無いフォルダも覚える。出力先は整理のときに作られるので、存在を
        条件にすると、これから作るフォルダ名を打ち込むやり方が断られる。

        積み重ねる。次を選んでも前に選んだ場所は消えない。2 か所へ交互に
        整理する利用者が、戻るたびに選び直さずに済むようにするため。
        """
        resolved = directory.resolve()
        with self._lock:
            if not self._contains(resolved):
                self._roots = (*self._roots, resolved)
        return resolved

    def allows(self, path: Path) -> bool:
        """その場所へ書き出してよいかを答える"""
        with self._lock:
            return self._contains(path.resolve())

    def _contains(self, resolved: Path) -> bool:
        """覚えのどれかの配下かを、区切りで見る。

        許可された場所の判定（within_allowed）と同じ「配下かどうか」で揃える。
        文字列の前方一致にすると、`/mnt/manga` を選んだだけで `/mnt/manga-秘密`
        へも書けてしまう。
        """
        return any(resolved.is_relative_to(root) for root in self._roots)
