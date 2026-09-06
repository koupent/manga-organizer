import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);
const READY_PREFIX = "MANGA_API_READY ";

/**
 * 画面を配信するオリジン。サイドカーの既定は dev server（5173）だけなので、
 * preview（4173）から呼ぶと CORS で弾かれる。E2E は既定で preview を見るが、
 * E2E_DEV_SERVER=1 のときは dev server を見るため、両方を許可しておく。
 * 検証用のサイドカーは使い捨てで、待ち受けも 127.0.0.1 に限られる。
 */
const ALLOWED_ORIGINS = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];

export type Sidecar = {
  baseUrl: string;
  token: string;
  workDir: string;
  /** 読み書きを許可した場所。既定では workDir と同じ */
  allowedRoot: string;
  stop: () => void;
};

export type SidecarOptions = {
  /**
   * 許可する場所を、作業ディレクトリの下のこのフォルダだけに狭める。
   *
   * 実機のシェルはホームだけを許可して起動する（src-tauri/src/lib.rs）ので、
   * 2 台目のドライブや NAS は必ず許可の外に来る。その状況を作りたいテストは、
   * 作業ディレクトリの一部だけを許可させ、残りを「外」として使う。
   * 省くと今までどおり作業ディレクトリ全体を許可する。
   */
  allowedSubdirectory?: string;
};

/** 実際のサイドカーを子プロセスとして起動し、接続情報を返す */
export async function startSidecar(
  options: SidecarOptions = {},
): Promise<Sidecar> {
  const workDir = mkdtempSync(join(tmpdir(), "manga-e2e-"));
  const allowedRoot = options.allowedSubdirectory
    ? join(workDir, options.allowedSubdirectory)
    : workDir;
  if (allowedRoot !== workDir) mkdirSync(allowedRoot, { recursive: true });
  const child: ChildProcessWithoutNullStreams = spawn(
    "uv",
    [
      "run",
      "python",
      "-m",
      "manga_api",
      "--state-dir",
      join(workDir, "state"),
      "--allow-root",
      allowedRoot,
      ...ALLOWED_ORIGINS.flatMap((origin) => ["--allow-origin", origin]),
      "--log-level",
      "warning",
    ],
    { cwd: CORE_DIR },
  );

  const info = await new Promise<{ host: string; port: number; token: string }>(
    (resolve, reject) => {
      let buffered = "";
      const timer = setTimeout(
        () => reject(new Error(`サイドカーが起動しませんでした: ${buffered}`)),
        60_000,
      );
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered
          .split("\n")
          .find((l) => l.startsWith(READY_PREFIX));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line.slice(READY_PREFIX.length)));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(`サイドカーが終了しました (code=${code}): ${buffered}`),
        );
      });
    },
  );

  return {
    baseUrl: `http://${info.host}:${info.port}`,
    token: info.token,
    workDir,
    allowedRoot,
    stop: () => child.kill(),
  };
}

/** 検証用の ZIP を作る。ページの中身は色で見分けられるようにする */
export function writeArchive(
  workDir: string,
  name: string,
  entries: { name: string; color: string }[],
): string {
  const script = `
import io, json, sys, zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

target = Path(sys.argv[1])
entries = json.loads(sys.argv[2])
font = ImageFont.load_default(size=120)
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for entry in entries:
        canvas = Image.new("RGB", (600, 900), entry["color"])
        ImageDraw.Draw(canvas).text(
            (300, 450), entry["name"], font=font, anchor="mm", fill="white"
        )
        buffer = io.BytesIO()
        canvas.save(buffer, "JPEG", quality=85)
        archive.writestr(entry["name"], buffer.getvalue())
`;
  const scriptPath = join(workDir, "make_archive.py");
  writeFileSync(scriptPath, script);
  const target = join(workDir, name);
  execFileSync(
    "uv",
    ["run", "python", scriptPath, target, JSON.stringify(entries)],
    {
      cwd: CORE_DIR,
    },
  );
  return target;
}
