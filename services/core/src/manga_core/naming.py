"""ファイル名の自然順ソート。

`001.jpg` と `cover.jpg` のように数字始まりと文字始まりが混在すると、
数値と文字列をそのまま比較するキーでは TypeError になる。ここでは要素を
(種別, 数値, 文字列) のタプルに正規化し、どの組み合わせでも比較できる
キーを返す。
"""

import re

_NUMBER_PATTERN = re.compile(r"(\d+)")
_NUMERIC_KIND = 0
_TEXT_KIND = 1


def natural_sort_key(text: str) -> list[tuple[int, int, str]]:
    """自然順ソート用のキーを生成する (1, 2, 10 の順になる)"""
    key: list[tuple[int, int, str]] = []
    for part in _NUMBER_PATTERN.split(text.lower()):
        if not part:
            continue
        if _NUMBER_PATTERN.fullmatch(part):
            key.append((_NUMERIC_KIND, int(part), ""))
        else:
            key.append((_TEXT_KIND, 0, part))
    return key
