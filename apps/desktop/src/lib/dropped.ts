import type { SidecarClient } from "../api/client";

/** サイドカーが返す照合の結果 */
type Resolution = Awaited<ReturnType<SidecarClient["resolveDropped"]>>;

/** ドロップから引き当てた実パスと、引き当てられなかった理由 */
export type DroppedPaths = { paths: string[]; error: string };

/**
 * ドロップに載っている実パスを取り出す。
 *
 * VS Code のエクスプローラーや Linux のファイルマネージャは
 * text/uri-list に file:// の URI を載せてくる。取れる場合はそれが確実。
 */
function pathsFromTransfer(transfer: DataTransfer): string[] {
  const raw =
    transfer.getData("text/uri-list") || transfer.getData("text/plain") || "";
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      if (!line.startsWith("file://")) return line.startsWith("/") ? line : "";
      try {
        return decodeURIComponent(new URL(line).pathname);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/**
 * 引き当てられなかったものを、利用者が次の手を打てる言葉にする。
 *
 * 「見つかりません」だけでは探し方が分からない。どこを探したのかまで示す。
 */
function describeProblems(result: Resolution): string {
  const problems: string[] = [];
  if (result.unresolved.length > 0) {
    const roots = (result.searched_roots ?? []).join(" / ") || "(制限なし)";
    problems.push(
      `見つかりません: ${result.unresolved.join(", ")}` +
        `（探した場所: ${roots}。この中に無いファイルは扱えません）`,
    );
  }
  if (result.ambiguous.length > 0) {
    problems.push(
      `同名が複数あるため特定できません: ${result.ambiguous.join(", ")}`,
    );
  }
  return problems.join(" / ");
}

/**
 * ドロップされた内容を実パスに結びつける。
 *
 * まず実パスが載っていればそれを使う。載っていない場合（多くのブラウザ）は
 * 名前とサイズを手がかりに、許可された場所の中から探して結びつける。
 * Tauri のネイティブなドロップは実パスが直接届くので、App が処理する。
 *
 * ファイル整理とページ並べ替えは同じドロップを受ける。解決の仕方が 2 つ
 * あると片方だけ直した取りこぼしが起きるため、入り口をここ 1 つに絞る。
 */
export async function resolveDroppedPaths(
  client: SidecarClient,
  transfer: DataTransfer,
): Promise<DroppedPaths> {
  const direct = pathsFromTransfer(transfer);
  if (direct.length > 0) return { paths: direct, error: "" };

  const dropped = Array.from(transfer.files).map((file) => ({
    name: file.name,
    size: file.size,
  }));
  if (dropped.length === 0) {
    return {
      paths: [],
      error:
        "ドロップされた内容からファイルを取り出せませんでした。" +
        "「ファイルを選ぶ」から辿ってください",
    };
  }

  try {
    const result = await client.resolveDropped(dropped);
    return { paths: result.resolved, error: describeProblems(result) };
  } catch (reason) {
    return { paths: [], error: String((reason as Error).message ?? reason) };
  }
}
