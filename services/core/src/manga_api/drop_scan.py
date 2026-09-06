"""ドロップされたファイルを探すための走査。

`POST /api/resolve` は、ブラウザが実パスを渡さないぶんを、許可された場所の
走査で補う。Tauri シェルが許可するのは利用者のホームなので、上限を置かない
と画面へファイルを 1 つ落とすたびにホーム全体を歩き切る。撮り溜めた写真も、
ビルドの中間物も、他人のアプリのキャッシュも、全部である。

そこで 1 回の要求で見る項目数に上限を置く（``RESOLVE_MAX_ENTRIES``）。上限は
許可された場所ごとではなく要求ごとに 1 つ。許可が 2 つに増えたら歩く量も
2 倍、では上限を置いた意味が無いため。

歩き方は**浅いところから先に見る**（幅優先）。深さ優先のまま件数の上限だけを
被せると、たまたま先に入った枝（`~/.cache` など）だけで上限を使い切り、
`~/ダウンロード` に落ちているファイルへ一度も辿り着かなくなる。利用者から
見れば「ドロップが効かない」であり、上限を入れたせいで機能そのものが壊れる。

深さの上限は別に置かない。件数の上限があれば、深い方向へ潜り続けても項目数
を食い尽くした時点で止まるので、深さは自然に頭打ちになる。つまみは 1 つで
足りる。
"""

import os
from collections import deque
from collections.abc import Iterable, Iterator
from pathlib import Path

# 1 回の要求で見るファイルシステムの項目数の上限。ホーム直下に数万の項目が
# ある機械でも、落としたファイルが数階層下にあれば届く程度を見込んでいる
RESOLVE_MAX_ENTRIES = 20_000


def walk_shallow_first(roots: Iterable[Path]) -> Iterator[Path]:
    """許可された場所を、浅いところから順に、上限の範囲で歩く。

    上限は呼ばれるたびに読み直す（既定引数へ畳み込まない）。予算は要求ごとに
    1 つなので、場所をいくつ渡してもここで合わせて ``RESOLVE_MAX_ENTRIES``
    件までしか見ない。

    使い切ったら黙って終わる。呼ぶ側からは見つからなかったときと区別が
    付かないが、それでよい。「打ち切った」を応答で伝えると
    `services/core/openapi.json` が動くうえ画面にも分岐が要るのに、利用者に
    できることは「選び直す」で変わらないため。
    """
    remaining = RESOLVE_MAX_ENTRIES
    queue = deque(root for root in roots if root.is_dir())
    while queue and remaining > 0:
        try:
            with os.scandir(queue.popleft()) as entries:
                for entry in entries:
                    remaining -= 1
                    found = Path(entry.path)
                    # リンクの先へは入らない。許可の中に置かれたリンクが外を
                    # 指していると、そこから外を歩き出す（rglob も入らない）
                    if entry.is_dir(follow_symlinks=False):
                        queue.append(found)
                    yield found
                    if remaining <= 0:
                        # 次の項目を引く前に抜ける。引いてから捨てると、
                        # 数えた数より 1 つ多く見たことになる
                        break
        except OSError:
            # 読めない、あるいは歩いている間に消えた場所。ホームには珍しく
            # ないので、そこだけ諦めて次の枝を歩く
            continue
