"""公開しているスキーマ（openapi.json）を作り直す。

``services/core/openapi.json`` は画面の型（``apps/desktop/src/api/schema.ts``）の
元になる成果物で、画面は ``operationId`` を文字列で直接書いている。作り直す手順が
コミットされていないと、経路を触った人が手元の一行スクリプトで書き出すことになり、
書き方が少し違うだけで全行が差分になって、本当の変更がその中に埋もれる。

使い方（``services/core`` で実行する）::

    uv run python scripts/export_openapi.py            # 書き出す
    uv run python scripts/export_openapi.py --check    # 食い違いだけ見る
"""

import argparse
import json
import sys
import tempfile
from pathlib import Path

from manga_api.app import create_app

# 成果物の置き場。scripts/ の 1 つ上が services/core
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "openapi.json"


def render() -> bytes:
    """いまのコードが公開するスキーマを、コミット済みと同じ書き方で組み立てる。

    ``ensure_ascii=False`` は説明文の日本語をそのまま残すため。字下げ 2 文字・
    キーは FastAPI が組み立てた順のまま（``sort_keys`` は使わない）・末尾に改行 1 つ、
    のどれか 1 つでも違えば中身が同じでも全行が差分になり、比較が役に立たなくなる。

    改行は必ず LF にする。Windows でも成果物を作り直せる必要があるが、テキストとして
    書くと LF が CRLF に変換され、中身を何も変えていないのに全行が差分になる。
    """
    # 状態の置き場は使い捨てにする。既定では利用者の ~/.manga-organizer を開き、
    # 残っている実行中のジョブを「中断された」として書き換えてしまう。スキーマを
    # 見るだけの操作で手元の履歴を壊さないよう、空の場所を渡す。
    # スキーマは経路の定義だけで決まるので、どこを渡しても中身は変わらない
    with tempfile.TemporaryDirectory() as throwaway:
        schema = create_app(state_dir=Path(throwaway)).openapi()
    return (json.dumps(schema, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    """書き出すか、食い違いを報せる。合っていれば 0 を返す"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="書き換えず、コミット済みと食い違っていれば失敗する",
    )
    args = parser.parse_args(argv)

    current = render()
    if not args.check:
        OUTPUT_PATH.write_bytes(current)
        return 0

    committed = OUTPUT_PATH.read_bytes() if OUTPUT_PATH.exists() else b""
    if committed == current:
        return 0
    # 黙って書き換えない。書き換えると、経路を変えた本人が気づかないまま
    # 画面の型と食い違ったスキーマが公開される
    print(
        f"{OUTPUT_PATH} がいまのコードと食い違っています。\n"
        "services/core で uv run python scripts/export_openapi.py を実行し、"
        "差分を確かめてからコミットしてください。",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
