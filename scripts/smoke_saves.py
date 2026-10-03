"""配る物のサイドカーで、ページ並べ替え・ページ分割・サムネイル作成の保存を
実際に通して確かめる煙試験。

Tauri シェルと同じ条件で起こす（stdout と stdin を pipe にし、
`--exit-with-parent` を渡し、READY を読んだら stdout を閉じる。Windows では
コンソール窓を作らない）。単体のテストは Python のソースを直に動かすので、
凍結したサイドカーをこの条件で起こしたときだけ起きる不具合は拾えない。

使い方: python scripts/smoke_saves.py <サイドカーを起こすコマンド...>
  例: python scripts/smoke_saves.py "C:/.../resources/sidecar/manga-api.exe"
      python scripts/smoke_saves.py python -m manga_api

標準ライブラリだけで書く（CI のどの Python でも動かせるように）。
"""

import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
import zlib
from pathlib import Path

READY_PREFIX = "MANGA_API_READY "
CREATE_NO_WINDOW = 0x08000000


def png(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    """単色の PNG を作る。見分けは色で付ける"""

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\x00" + bytes(rgb) * width
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * height))
        + chunk(b"IEND", b"")
    )


def png_size(data: bytes) -> tuple[int, int]:
    return struct.unpack(">II", data[16:24])


class Sidecar:
    """Tauri シェルと同じ条件で起こしたサイドカー"""

    def __init__(self, command: list[str], state_dir: Path) -> None:
        self.log = open(state_dir / "sidecar.log", "w")
        self.process = subprocess.Popen(
            [*command, "--state-dir", str(state_dir), "--exit-with-parent"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            creationflags=CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        deadline = time.monotonic() + 120
        while True:
            line = self.process.stdout.readline().decode("utf-8", "replace")
            if line.startswith(READY_PREFIX):
                ready = json.loads(line[len(READY_PREFIX) :])
                break
            if not line or time.monotonic() > deadline:
                raise SystemExit(f"サイドカーが READY を出しませんでした: {line!r}")
        # シェルは READY を読んだら stdout の読み口を捨てる。同じにする
        self.process.stdout.close()
        self.base = f"http://{ready['host']}:{ready['port']}"
        self.token = ready["token"]

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = f"{self.base}{path}?" + urllib.parse.urlencode({"token": self.token})
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise SystemExit(
                f"{method} {path} が {error.code} を返しました: {detail}"
            ) from error

    def run_job(self, path: str, body: dict) -> dict:
        """ジョブを投げ、終わるまで待って結果を返す。失敗したら止める"""
        job_id = self.request("POST", path, body)["id"]
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            job = self.request("GET", f"/api/jobs/{job_id}")
            if job["state"] == "succeeded":
                return job["result"]
            if job["state"] in ("failed", "cancelled"):
                raise SystemExit(
                    f"{path} が {job['state']} になりました: {job.get('error')}\n"
                    + "\n".join(job.get("log", []))
                )
            time.sleep(0.5)
        raise SystemExit(f"{path} が終わりませんでした")

    def close(self) -> None:
        """親が終わったときと同じく stdin を閉じ、サイドカーが自分で終わるのを見る"""
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            raise SystemExit("stdin を閉じてもサイドカーが終わりませんでした") from None
        finally:
            self.log.close()


def pages_of(archive: Path) -> list[tuple[str, bytes]]:
    """ページだけを名前順に。加工前の画像（.manga-organizer/ の下）は数えない"""
    with zipfile.ZipFile(archive) as opened:
        return [
            (name, opened.read(name))
            for name in sorted(opened.namelist())
            if name.lower().endswith(".png") and not name.startswith(".")
        ]


def digest(archive: Path) -> str:
    return hashlib.sha256(archive.read_bytes()).hexdigest()


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main(command: list[str]) -> None:
    work = Path(tempfile.mkdtemp(prefix="manga-organizer-smoke-"))
    state = work / "state"
    state.mkdir()
    archive = work / "見本.zip"
    # 単ページ 3 枚と見開き 1 枚。色で見分ける
    colors = [(200, 40, 40), (40, 200, 40), (40, 40, 200), (200, 200, 40)]
    sizes = [(60, 90), (60, 90), (60, 90), (180, 90)]
    with zipfile.ZipFile(archive, "w") as created:
        for index, (color, size) in enumerate(zip(colors, sizes, strict=True), 1):
            created.writestr(f"{index:03d}.png", png(*size, color))

    sidecar = Sidecar(command, state)
    try:
        # ページ並べ替え: 1 枚目と 2 枚目を入れ替える
        names = [name for name, _ in pages_of(archive)]
        before = pages_of(archive)
        changed_from = digest(archive)
        sidecar.run_job(
            "/api/jobs/reorder",
            {"archive": str(archive), "order": [names[1], names[0], *names[2:]]},
        )
        after = pages_of(archive)
        check(digest(archive) != changed_from, "並べ替えても変わっていません")
        check(after[0][1] == before[1][1], "並べ替えた順になっていません")
        print("ページ並べ替え: 保存できました")

        # ページ分割: 見開きを真ん中で割る
        scan = sidecar.run_job("/api/jobs/split-scan", {"archive": str(archive)})
        rows = [
            {
                "names": row["names"],
                "split": {"x": row["width"] // 2} if row["is_spread"] else None,
            }
            for row in scan["rows"]
        ]
        check(any(row["split"] for row in rows), "見開きが見つかりません")
        changed_from = digest(archive)
        result = sidecar.run_job(
            "/api/jobs/split",
            {"archive": str(archive), "token": scan["token"], "rows": rows},
        )
        check(digest(archive) != changed_from, "割ってもアーカイブが変わっていません")
        check(result["split_count"] == 1, f"割った数が違います: {result}")
        check(len(pages_of(archive)) == 5, "割った後のページ数が 5 ではありません")
        print("ページ分割: 保存できました")

        # サムネイル作成: 1 枚目を 2:3 で小さく切り抜く
        first = pages_of(archive)[0][0]
        changed_from = digest(archive)
        sidecar.run_job(
            "/api/jobs/cover",
            {"archive": str(archive), "name": first, "crop": [0, 0, 40, 60]},
        )
        check(digest(archive) != changed_from, "切り抜いても変わっていません")
        check(
            png_size(pages_of(archive)[0][1]) == (40, 60),
            "切り抜いた大きさになっていません",
        )
        print("サムネイル作成: 保存できました")
    finally:
        sidecar.close()
    print("サイドカーは stdin を閉じると終わりました")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1:])
