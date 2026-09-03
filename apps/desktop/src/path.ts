/**
 * ファイルが置かれている場所を返す。
 *
 * 配布先は Windows だが検証は Linux で走るので、区切りは \ と / の両方を見る。
 * 根の直下は空文字ではなく "/" にして、場所が無いのと区別できるようにする。
 */
export function parentDirectory(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut < 0) return "";
  return path.slice(0, cut) || "/";
}
