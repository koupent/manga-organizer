import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = fileURLToPath(new URL("../../../services/core", import.meta.url));
const READY_PREFIX = "MANGA_API_READY ";

export type Sidecar = {
  baseUrl: string;
  token: string;
  workDir: string;
  stop: () => void;
};

/** 実際のサイドカーを子プロセスとして起動し、接続情報を返す */
export async function startSidecar(): Promise<Sidecar> {
  const workDir = mkdtempSync(join(tmpdir(), "manga-e2e-"));
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
      workDir,
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
        const line = buffered.split("\n").find((l) => l.startsWith(READY_PREFIX));
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
        reject(new Error(`サイドカーが終了しました (code=${code}): ${buffered}`));
      });
    },
  );

  return {
    baseUrl: `http://${info.host}:${info.port}`,
    token: info.token,
    workDir,
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
  execFileSync("uv", ["run", "python", scriptPath, target, JSON.stringify(entries)], {
    cwd: CORE_DIR,
  });
  return target;
}
