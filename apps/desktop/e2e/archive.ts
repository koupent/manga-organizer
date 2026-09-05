import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ZIP の中身を、viewer と同じ「ページ」の見方で読み出す。
 *
 * #66 で加工前の元画像と manifest を同じ ZIP に同梱するようになり、
 * ZIP のエントリはページだけではなくなった。エントリを全部ページとみなすと
 * 画像でない manifest を開いて落ちるし、`sorted(namelist())[0]` は
 * `.`（0x2E）が `0`（0x30）より前に並ぶせいで `.manga-organizer/manifest.json`
 * を表紙として拾う。E2E が見たいのは「ページの一覧」であって
 * 「ZIP のエントリの一覧」ではない。
 *
 * 判定も置き場の名前も manga_core を唯一の正本として呼び出す。規則を
 * TypeScript 側へ書き写すと、正本が変わったときに E2E だけ古い規則で
 * 検証し続け、その食い違いに誰も気づけない。
 */
const CORE_DIR = fileURLToPath(
  new URL("../../../services/core", import.meta.url),
);

/** 正本の判定を使うための import。インライン python の先頭に置く */
export const VIEWER_CONTRACT_IMPORT =
  "from manga_core.viewer_contract import is_viewer_page";

/**
 * CORE_DIR で python を動かし、標準出力を返す。
 *
 * サイドカーと同じ環境なので、manga_core も Pillow もそのまま import できる。
 */
export function runPython(script: string, ...args: string[]): string {
  return execFileSync("uv", ["run", "python", "-c", script, ...args], {
    cwd: CORE_DIR,
    encoding: "utf8",
  });
}

/** viewer がページとして読むエントリ名を、viewer と同じ辞書順で返す */
export function pageEntriesOf(archive: string): string[] {
  const output = runPython(
    `
import json, sys, zipfile
${VIEWER_CONTRACT_IMPORT}
with zipfile.ZipFile(sys.argv[1]) as archive:
    print(json.dumps(sorted(n for n in archive.namelist() if is_viewer_page(n))))
`,
    archive,
  );
  return JSON.parse(output);
}

/**
 * 同梱された元画像と記録（#66）。ページ以外のエントリを名指しで見る。
 *
 * ページの一覧だけを見ていると、同梱そのものが失われても気づけない。
 */
export function storedOriginalsOf(archive: string): {
  manifest: boolean;
  originals: string[];
} {
  const output = runPython(
    `
import json, sys, zipfile
from manga_core.original_store import MANIFEST_ENTRY, ORIGINALS_PREFIX
with zipfile.ZipFile(sys.argv[1]) as archive:
    names = archive.namelist()
print(json.dumps({
    "manifest": MANIFEST_ENTRY in names,
    "originals": sorted(n for n in names if n.startswith(ORIGINALS_PREFIX)),
}))
`,
    archive,
  );
  return JSON.parse(output);
}

/**
 * ページ名ごとの寸法を viewer と同じ辞書順で返す。
 *
 * 切り抜きを広げられたか（#66）は、枠が動いたことではなく出来上がった画像が
 * 大きくなったことでしか確かめられない。ページ以外のエントリは画像ではないので
 * 除く。manifest.json を Image.open すると、そこで落ちて比較まで届かない。
 */
export function pageSizesOf(archive: string): Record<string, [number, number]> {
  const output = runPython(
    `
import io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
result = {}
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in sorted(archive.namelist()):
        if not is_viewer_page(name):
            continue
        with Image.open(io.BytesIO(archive.read(name))) as image:
            result[name] = list(image.size)
print(json.dumps(result))
`,
    archive,
  );
  return JSON.parse(output);
}

/** ページの中身（色）を読み出し、加工や並べ替えが実際に効いたか確かめる */
export function coloursOf(archive: string): Record<string, string> {
  const output = runPython(
    `
import io, json, sys, zipfile
from PIL import Image
${VIEWER_CONTRACT_IMPORT}
result = {}
with zipfile.ZipFile(sys.argv[1]) as archive:
    for name in sorted(archive.namelist()):
        if not is_viewer_page(name):
            continue
        with Image.open(io.BytesIO(archive.read(name))) as image:
            result[name] = "#%02x%02x%02x" % image.convert("RGB").getpixel((20, 20))
print(json.dumps(result))
`,
    archive,
  );
  return JSON.parse(output);
}
