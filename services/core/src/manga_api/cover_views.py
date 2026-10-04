"""表紙の状態を画面へ渡す形（``GET /api/cover``）。

画面は「どれだけ広い絵が残っているか」と「前回どこを選んだか」を 1 度に
受け取って、切り抜き枠を置く。加工後の 1 枚と加工前の姿を別の入口に分けると、
2 回問い合わせる間に片方だけ古い値を見た状態が作れてしまうため、
1 つの応答にまとめてある。その組み立てをここに置く。

加工そのもの（``POST /api/jobs/cover``）は ``cover_job``。
"""

import io
import logging
from pathlib import Path
from typing import Any

from PIL import Image
from pydantic import BaseModel, Field

from manga_core.original_store import OriginalStoreError, find_original, read_original

logger = logging.getLogger(__name__)


class OperationView(BaseModel):
    """元画像に施した加工 1 つ分。params の形は kind ごとに決まる"""

    kind: str
    params: dict[str, Any] = Field(default_factory=dict)


class OriginalView(BaseModel):
    """いま見ている 1 枚の、加工前の姿。

    ZIP 内のどのエントリに入っているかは返さない。返すと、書き換えられた
    manifest を使って画面からアーカイブ内の任意のエントリを読ませる道ができる。
    画面が要るのは「どれだけ広い絵が残っているか」と「前回どこを選んだか」だけ。
    """

    width: int
    height: int
    # 既定値を持たせない。持たせると生成される画面側の型で任意項目になり、
    # 常に載せているという実装と食い違う
    operations: list[OperationView]


class CoverView(BaseModel):
    """表紙の状態。

    寸法と見開き判定は「いま保存されている 1 枚」を指す。original は、その
    1 枚が加工の結果なら加工前の姿を添える。画面は加工前を対象にして枠を
    置き直すので、両方を 1 回の問い合わせで受け取る必要がある。
    """

    name: str
    width: int
    height: int
    is_spread: bool
    target_aspect_ratio: float
    # 既定値を持たせない。載せ忘れと「元画像が無い」を、画面側が null で
    # 見分けられるようにする
    original: OriginalView | None = Field(
        description="加工前の画像。一度も加工していなければ null",
    )


def describe_original(archive_path: Path, image: bytes) -> OriginalView | None:
    """加工後の 1 枚から、加工前の姿を引く。記録が無ければ None"""
    ref = find_original(archive_path, image)
    if ref is None:
        return None
    try:
        with Image.open(io.BytesIO(read_original(archive_path, ref))) as opened:
            width, height = opened.size
    except (OriginalStoreError, OSError):
        # 記録はあるが読めない。同梱が失われた古いアーカイブでも画面が
        # 開けるよう、元画像が無いものとして扱う
        logger.warning("元画像を読めませんでした: %s", archive_path)
        return None
    return OriginalView(
        width=width,
        height=height,
        operations=[
            OperationView(kind=operation.kind, params=dict(operation.params))
            for operation in ref.operations
        ],
    )
