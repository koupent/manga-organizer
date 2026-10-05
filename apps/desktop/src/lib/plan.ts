/**
 * 解析結果を 3 階層の一覧に組み直す（#70 第 3・第 4 段階）。
 *
 * 利用者は「最終的にできる ZIP はこれ」を実行前に見て、要らないものを外す。
 * 見せる形は 放り込んだもの → 見つかったアーカイブ → 出来上がる本 の 3 階層で、
 * どの段にもチェックが付く（案 Z-2「全段に三態」）。
 *
 * ここは描画も通信もしない純関数だけにしてある。チェックの伝播と件数は
 * 「どの本が残っているか」だけで決まるので、画面を動かさずに確かめられる。
 */

/** 解析ジョブ（`POST /api/jobs/analyze`）が返す本 1 冊 */
export type PlannedBook = {
  source: string;
  entry: string;
  output_name: string;
  volume: number | null;
  /**
   * 巻数をどこから読んだか（#114）。pattern / last-number / position / none。
   * 古いサイドカーや台本の応答には無いことがある
   */
  volume_origin?: string;
  /** 巻数を読み取った名前。position のときは空 */
  volume_source_name?: string;
  issues: string[];
  /** この本が既に整理の出力そのものか（#73 第 1・2 段階の判定） */
  organized: boolean;
  /** 整理済みでない理由 1 つ。整理済みなら null */
  organized_reason: string | null;
  /**
   * 理由の中身を利用者が読める 1 文で（#126）。どのページ・ファイル・フォルダが
   * 何と違うか。古いサイドカーや台本の応答には無いことがある
   */
  organized_detail?: string | null;
  /** 本の名前から読んだ作品名。整理済みでなければ null */
  title: string | null;
  /** 本の名前から読んだ著者名。整理済みでなければ null */
  author: string | null;
  /**
   * アーカイブ全体が 1 冊のとき、そのファイルの大きさ（バイト）（#163）。
   * 中の 1 冊なら null。古いサイドカーや台本の応答には無いことがある
   */
  size?: number | null;
};

/**
 * 目次を読めなかった入れ物に付ける印。
 *
 * 読めなくても行は残り、既定で選ばれたまま整理される（中身は実行時に
 * 展開して初めて分かる）。印を出さないと、読めなかったことが誰にも
 * 見えないまま握りつぶされる。
 */
export const TOC_UNREADABLE = "toc-unreadable";

/** 巻数が名前から読めなかった */
export const VOLUME_UNKNOWN = "volume-unknown";

/** 巻数を読んだ根拠が弱く、誤読しうる */
export const VOLUME_UNCERTAIN = "volume-uncertain";

/**
 * 作る本どうしで同じ名前になる（サイドバー案 段階 5）。
 *
 * サイドカーは返さない。名前は画面が作品名・著者・巻数から毎回組み立てる
 * ので、重なりも画面が見つける。後ろの本には ``_1`` が付いて黙って出来る。
 */
export const VOLUME_DUPLICATE = "volume-duplicate";

/** 行の種類。folder と archive は入れ物、book が生成の単位 */
export type PlanKind = "folder" | "archive" | "book";

/** 三態。indeterminate は「下の一部だけが残っている」 */
export type CheckState = boolean | "indeterminate";

/** 一覧の 1 行 */
export type PlanRow = {
  /** 行を見分ける鍵。チェックの状態はこの鍵で覚える */
  id: string;
  kind: PlanKind;
  /** 階層の深さ。放り込んだものが 0 */
  level: number;
  /** 入れ物の行の、ディスク上の場所。本の行では空 */
  path: string;
  /** 本の行の、元になったアーカイブ。入れ物の行では空 */
  source: string;
  /** 本の行の、アーカイブ内での位置。全体で 1 冊なら空 */
  entry: string;
  /** 巻数。読めなかったものは null。利用者が直したらその値（``applyVolumes``） */
  volume: number | null;
  /** 解析が決めた巻数。直しても変わらない。読んだ数字を塗るのに使う */
  autoVolume: number | null;
  /** 巻数をどこから読んだか。入れ物の行では空 */
  volumeOrigin: string;
  /** 巻数を読み取った名前。入れ物の行と position では空 */
  volumeSourceName: string;
  /** 実行前に見せる印 */
  issues: string[];
  /**
   * この本が既に整理の出力そのものか。
   *
   * 既定のチェックがこれで決まる（#73 段階 4b）。整理済みの本は既定でオフに
   * なり、作る冊数からも外れる。行そのものは消さない。消すと「作らない」と
   * 「見つからなかった」が区別できなくなる。
   */
  organized: boolean;
  /**
   * 整理済みでない理由 1 つ。整理済みなら空文字。
   *
   * ``issues`` と同じく、欄そのものは省かない。省くと画面から
   * 「整理済みでない」のか「判定が届いていない」のかを区別できない。
   */
  organizedReason: string;
  /** 理由の中身。無ければ空文字（#126） */
  organizedDetail: string;
  /**
   * その本自身の作品名。持たない本と入れ物の行では空文字（#73 段階 4a）。
   *
   * サイドカーは持たない本に null を返すので、行を作るときに空文字へ均す。
   * 均さずに渡すと、欄そのものが届かなかった本（古いサイドカー・台本）では
   * ``undefined`` になり、「空でない」＝「自分の名前を持つ」と読まれてしまう。
   * その本は左の列を無視した名前で予告され、投入にも半分だけの名前が載る。
   */
  title: string;
  /** その本自身の著者名。``title`` と同じ理由で空文字に均す */
  author: string;
  /** 本のファイルの大きさ（バイト）。分からない本と入れ物の行では null（#163） */
  size: number | null;
  /**
   * この行の上にある入れ物の鍵。外側から順に並ぶ。
   *
   * 組み立てる時点では親が分かっているので、ここに控えておく。上を触った
   * ことを下へ伝えるのに使う（``effectiveOff``）。行が後から生えても、
   * 生えた行の側から上を見に行けるようにするため、親の側には持たせない。
   */
  ancestors: string[];
  /**
   * この行にぶら下がる葉の鍵。
   *
   * 葉（それ以上分かれない行）だけがチェックの状態を持ち、親の三態は葉から
   * 数えて決める。親にも状態を持たせると、親と子で食い違ったときにどちらが
   * 正しいのかが決められなくなる。
   */
  leaves: string[];
  /**
   * 出力先に既にある本の行か（#178）。投入したものからではなく、出力先の
   * 作品フォルダから起こした行で、元の名前を持たない
   */
  existing: boolean;
};

/** 整理の対象として扱うアーカイブ形式。サイドカーの ARCHIVE_SUFFIXES と揃える */
const ARCHIVE_SUFFIXES = [
  ".zip",
  ".cbz",
  ".rar",
  ".cbr",
  ".7z",
  ".cb7",
  ".epub",
];

/** 配布先は Windows だが検証は Linux で走るので、区切りは両方を見る */
const SEPARATORS = ["/", "\\"];

/** 名前だけを見て、アーカイブとして扱うかを判定する */
function isArchivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** 入れ物の行の種類。ZIP に入っていない裸の画像フォルダも 1 冊になる */
function containerKind(path: string): PlanKind {
  return isArchivePath(path) ? "archive" : "folder";
}

/** child が parent の下にあるか。parent 自身は含めない */
export function isInside(parent: string, child: string): boolean {
  return SEPARATORS.some((separator) => child.startsWith(parent + separator));
}

/** 本 1 冊を見分ける鍵。名前は作品名と著者で変わるので鍵にしない */
export function bookId(book: { source: string; entry: string }): string {
  return `${book.source}\u0000${book.entry}`;
}

/** 入れ物の行を作る。子がまだ無ければ、その行自身が葉になる */
function containerRow(
  path: string,
  level: number,
  ancestors: string[],
  leaves: string[],
  issues: string[],
): PlanRow {
  return {
    id: path,
    kind: containerKind(path),
    level,
    path,
    source: "",
    entry: "",
    volume: null,
    autoVolume: null,
    volumeOrigin: "",
    volumeSourceName: "",
    issues,
    // 判定は本 1 冊ごとに下すもので、入れ物そのものは対象にならない
    organized: false,
    organizedReason: "",
    organizedDetail: "",
    title: "",
    author: "",
    size: null,
    ancestors,
    leaves: leaves.length > 0 ? leaves : [path],
    existing: false,
  };
}

/** 本の行を作る */
function bookRow(
  book: PlannedBook,
  level: number,
  ancestors: string[],
): PlanRow {
  const id = bookId(book);
  return {
    id,
    kind: "book",
    level,
    path: "",
    source: book.source,
    entry: book.entry,
    volume: book.volume,
    autoVolume: book.volume,
    volumeOrigin: book.volume_origin ?? "",
    volumeSourceName: book.volume_source_name ?? "",
    issues: book.issues,
    organized: book.organized,
    // サイドカーは理由なしを null で返す。そのまま行の属性へ渡すと
    // 画面に "null" の 4 文字が出るので、ここで空文字に均す
    organizedReason: book.organized_reason ?? "",
    organizedDetail: book.organized_detail ?? "",
    // 名前も同じく空文字へ均す。判定（carriesOwnName）が空文字だけを
    // 「自分の名前を持たない」と読めるようにするため
    title: book.title ?? "",
    author: book.author ?? "",
    size: book.size ?? null,
    ancestors,
    leaves: [id],
    existing: false,
  };
}

/**
 * 投入したものと走査・解析の結果から、一覧の行を組み立てる。
 *
 * 入れ物の行は走査の結果（``containers``）から起こす。本（``book.source``）
 * から起こすと、目次を読み終えるまで 1 行も出せない。解析は走査だけを先に
 * 終えるので（#70 第 4 段階）、行は先に全部並び、本だけが後から生える。
 *
 * 走査がまだなら、放り込んだものの行だけが並ぶ。何も見えないまま待たせると、
 * 受け付けられたのかどうかが分からない。
 *
 * 目次を読めなかったアーカイブ（RAR・7z・壊れたもの）は本の行を持たないので、
 * その行自身が生成の単位になる。全段にチェックを置いてあるのはこのため。
 */
export function buildPlanRows(
  sources: string[],
  containers: string[],
  books: PlannedBook[],
  unreadable: string[] = [],
): PlanRow[] {
  const unreadableSet = new Set(unreadable);
  const issuesOf = (path: string): string[] =>
    unreadableSet.has(path) ? [TOC_UNREADABLE] : [];

  // 入れ物ごとに books を絞り込むと、入れ物 N × 本 N の総当たりになる。
  // 1 万件の蔵書では 1 描画あたり 1 億回の比較になり、解析中は本が生えるたびに
  // 描き直すので画面が固まる。先に元パスで束ねて、引くのは一発にする
  const booksBySource = new Map<string, PlannedBook[]>();
  for (const book of books) {
    const found = booksBySource.get(book.source);
    if (found) {
      found.push(book);
    } else {
      booksBySource.set(book.source, [book]);
    }
  }
  // 出来上がる名前の順に並べる（#162）。同じ巻の本が隣り合い、整理する前に
  // 要らない方を外せる。名前は解析が付けたもので、巻数を直しても並びは
  // 動かない。打ち直すたびに行が飛ぶと、↑↓ で隣の本へ移る操作が使えない
  for (const found of booksBySource.values()) {
    found.sort(
      (a, b) =>
        byName(sortName(a), sortName(b)) || byName(bookId(a), bookId(b)),
    );
  }
  // 入れ物は、中で一番先に来る本の名前で並べる。本が無い入れ物は後ろへ
  const firstName = (path: string) => {
    const first = booksBySource.get(path)?.[0];
    return first ? sortName(first) : undefined;
  };
  const byFirstName = (a: string, b: string) =>
    byKey(firstName(a), firstName(b)) || byName(a, b);
  const booksOf = (
    path: string,
    level: number,
    ancestors: string[],
  ): PlanRow[] =>
    (booksBySource.get(path) ?? []).map((book) =>
      bookRow(book, level, ancestors),
    );

  // 放り込んだものごとの行のまとまり。最後にまとまりごと名前の順に並べる
  const groups: { key: string | undefined; source: string; rows: PlanRow[] }[] =
    [];
  for (const source of sources) {
    const rows: PlanRow[] = [];
    const group = { key: firstName(source), source, rows };
    groups.push(group);
    const found = containers
      .filter((path) => path === source || isInside(source, path))
      .sort(byFirstName);

    if (found.length === 0 || found.includes(source)) {
      // 放り込んだものがそのまま入れ物。走査がまだのときもここに来る。
      // 同じパスで 2 行作らないよう、level 0 の行がその入れ物を兼ねる
      const children = booksOf(source, 1, [source]);
      rows.push(
        containerRow(
          source,
          0,
          [],
          children.map((child) => child.id),
          issuesOf(source),
        ),
        ...children,
      );
      continue;
    }

    // フォルダの中で見つかった入れ物。中の本の名前の順に並べてある
    group.key = firstName(found[0]!);
    const inside: PlanRow[] = [];
    for (const path of found) {
      const children = booksOf(path, 2, [source, path]);
      inside.push(
        containerRow(
          path,
          1,
          [source],
          children.map((child) => child.id),
          issuesOf(path),
        ),
        ...children,
      );
    }
    rows.push(
      containerRow(
        source,
        0,
        [],
        inside.flatMap((row) => row.leaves),
        issuesOf(source),
      ),
      ...inside,
    );
  }
  return groups
    .sort((a, b) => byKey(a.key, b.key) || byName(a.source, b.source))
    .flatMap((group) => group.rows);
}

/**
 * 並べるときの名前。重なりを避ける ``_1`` などは外す。解析は読んだ順に
 * ``_1`` を付けるので、付けたままだと並びが読んだ順に左右される。外せば
 * 既に在る ``第001巻_1.zip`` も ``第001巻.zip`` の隣に来る
 */
function sortName(book: PlannedBook): string {
  return book.output_name.replace(/_\d+(?=\.zip$)/, "");
}

/** 出力先に既にある、整理の規則どおりの名前の本 1 冊（#178） */
export type OutputBook = { path: string; volume: number | null; size: number };

/**
 * 出力先に既にある本の行を、一覧へ差し込む（#178）。
 *
 * 同じ巻の今回の本があれば、その直前に置く。先に在る本が先着で番号なしを
 * 持っていることが、隣を見れば分かる。今回の本に同じ巻が無いものは、最後に
 * 作品フォルダの行の下へまとめる。
 *
 * 投入したものの中にある本は渡さないこと（その本は投入の側の行で出ている）。
 */
export function withOutputBooks(
  rows: PlanRow[],
  books: OutputBook[],
  author: string,
  title: string,
): PlanRow[] {
  if (books.length === 0) return rows;
  const pending = new Map<string, OutputBook[]>();
  for (const book of books) {
    const base = formatVolumeName(author, title, book.volume);
    pending.set(base, [...(pending.get(base) ?? []), book]);
  }
  const placed: PlanRow[] = [];
  for (const row of rows) {
    if (row.kind === "book") {
      const base = baseNameOf(row, author, title);
      const found = pending.get(base);
      if (found) {
        placed.push(...found.map((book) => outputRow(book, row.level, [])));
        pending.delete(base);
      }
    }
    placed.push(row);
  }
  const rest = [...pending.values()].flat();
  if (rest.length === 0) return placed;
  const folder = parentOf(rest[0]!.path);
  const children = rest.map((book) => outputRow(book, 1, [folder]));
  return [
    ...placed,
    containerRow(
      folder,
      0,
      [],
      children.map((child) => child.id),
      [],
    ),
    ...children,
  ];
}

/** 出力先に既にある本の行。出来た本と同じ鍵にし、出来た本として扱わせる */
function outputRow(
  book: OutputBook,
  level: number,
  ancestors: string[],
): PlanRow {
  const id = bookId({ source: book.path, entry: "" });
  return {
    id,
    kind: "book",
    level,
    path: "",
    source: book.path,
    entry: "",
    volume: book.volume,
    autoVolume: book.volume,
    volumeOrigin: "",
    volumeSourceName: "",
    issues: [],
    organized: false,
    organizedReason: "",
    organizedDetail: "",
    title: "",
    author: "",
    size: book.size,
    ancestors,
    leaves: [id],
    existing: true,
  };
}

/** パスの親フォルダ。区切りは Windows と Linux の両方を見る */
function parentOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * 同じ巻の出来ている本のうち 1 冊を消したあと、残りに付け直す名前（#178）。
 *
 * 残りを今の番号の順（番号なし → ``_1`` → ``_2``）に並べ、先頭から番号なし・
 * ``_1``・``_2`` と付け直す。先に在った本ほど小さい番号を持っているので、
 * 今の番号の順がそのまま先着の順になる。名前の変わらない本は載せない。
 *
 * ``remaining`` には消した後に残っている、出来ている本のパスを全部渡す。
 * 消した本と同じフォルダ・同じ巻の名前のものだけを相手にする。
 */
export function renumbering(
  remaining: string[],
  trashed: string,
): { source: string; target: string }[] {
  const folder = parentOf(trashed);
  const base = withoutNumber(fileName(trashed));
  return remaining
    .filter(
      (path) =>
        parentOf(path) === folder && withoutNumber(fileName(path)) === base,
    )
    .sort((a, b) => numberOf(fileName(a)) - numberOf(fileName(b)))
    .map((path, index) => ({
      source: path,
      target:
        path.slice(0, path.length - fileName(path).length) +
        (index === 0 ? `${base}.zip` : `${base}_${index}.zip`),
    }))
    .filter((rename) => rename.source !== rename.target);
}

/** パスの末尾の名前 */
function fileName(path: string): string {
  return path.slice(parentOf(path).length + 1);
}

/** 名前から ``_1`` などの番号と拡張子を外す */
function withoutNumber(name: string): string {
  return name.replace(/(_\d+)?\.zip$/i, "");
}

/** 名前に付いた ``_1`` などの番号。番号なしは 0 */
function numberOf(name: string): number {
  const found = name.match(/_(\d+)\.zip$/i);
  return found ? Number(found[1]) : 0;
}

/**
 * 組み直した行のうち、中身が前と同じ行は前の行をそのまま使う（#168）。
 *
 * 解析は入れ物を 1 つ読むごとに行を組み直す。行が毎回新しくなると、一覧は
 * 中身の変わっていない行まで全部描き直し、数千冊では画面が目に見えて固まる。
 */
export function reuseRows(
  previous: readonly PlanRow[],
  next: PlanRow[],
): PlanRow[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    const old = byId.get(row.id);
    return old !== undefined && sameRow(old, row) ? old : row;
  });
}

/** 行の中身が同じか。並びの欄は要素ごとに比べる */
function sameRow(a: PlanRow, b: PlanRow): boolean {
  return (Object.keys(b) as (keyof PlanRow)[]).every((key) => {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) && Array.isArray(right))
      return (
        left.length === right.length &&
        left.every((item, index) => item === right[index])
      );
    return left === right;
  });
}

/** 名前の並べ方。数字は桁ではなく値で比べる（第2巻を第10巻より先に） */
function byName(a: string, b: string): number {
  return NAME_ORDER.compare(a, b);
}

/**
 * 並べ方の物差し。1 度だけ作って使い回す（#168）。``localeCompare`` に言語を
 * 渡すと呼ぶたびに作り直すので、数千冊を並べると目に見えて遅い
 */
const NAME_ORDER = new Intl.Collator("ja", { numeric: true });

/** 名前で並べる。名前が無いもの（本が無い入れ物）は後ろへ */
function byKey(a: string | undefined, b: string | undefined): number {
  if (a === undefined || b === undefined)
    return a === b ? 0 : a === undefined ? 1 : -1;
  return byName(a, b);
}

/**
 * 利用者が触った行だけを覚えた台帳。値は入れた（true）か外した（false）か。
 *
 * 触っていない行は載せない。載せない行の状態は ``defaultsOn`` から毎回
 * 導き直す（理由は ``effectiveOff``）。
 */
export type Decisions = ReadonlyMap<string, boolean>;

/**
 * もう処理の対象ではない葉（整理して出来た本、#172。出力先に既にある本、
 * #178）。三態を数えるときは入れない。数えると、出来た本の入った入れ物が
 * ずっと「一部」に見える
 */
type Done = { has(id: string): boolean };

const NOTHING_DONE: Done = new Set<string>();

/**
 * 誰も触っていない行の既定（#73 段階 4b）。
 *
 * 整理済みの本だけがオフ。一度整理した蔵書を入れ直したとき、既定がオンの
 * ままだと同じ本がもう一度作られる。入れ物には既定を持たせない。入れ物の
 * 三態は葉から数えて決まるので、ここで別に決めると親と子で食い違う。
 */
export function defaultsOn(row: PlanRow): boolean {
  return !(row.kind === "book" && row.organized);
}

/** それ以上分かれない行。チェックの状態を持つのはこれだけ */
function isLeaf(row: PlanRow): boolean {
  return row.leaves.length === 1 && row.leaves[0] === row.id;
}

/** その行が入っているか。自分の決定 → 一番内側の先祖 → 既定 の順で決まる */
function isOn(row: PlanRow, decisions: Decisions): boolean {
  const own = decisions.get(row.id);
  if (own !== undefined) return own;
  // ancestors は外側から順に並ぶので、後ろから見れば内側が先になる
  for (let index = row.ancestors.length - 1; index >= 0; index -= 1) {
    const decided = decisions.get(row.ancestors[index]!);
    if (decided !== undefined) return decided;
  }
  return defaultsOn(row);
}

/**
 * いま外れている葉の鍵を、覚えた決定と既定から毎回導き直す。
 *
 * 覚えるのは**利用者が触った行だけ**にする。解析は入れ物 1 つを読むごとに
 * 行を組み直すので、画面が推し量った値まで覚えると、組み直しのたびに書き
 * 潰されて利用者の選択が消える。既定（整理済みの本はオフ）を覚えずにここで
 * 導き直せば、後から生えた行にも同じように効く。
 *
 * 先祖は**内側から**見る。外側だけを見る（「先祖のどれかが外れていたら外す」）
 * と、フォルダを外してからその中のアーカイブを入れ直す操作が何も効かない。
 * 入れ直した本人の決定を外側の決定が覆すので、利用者にはクリックが握りつぶ
 * されたように見える。
 *
 * 返すのは葉の鍵だけ。入れ物の三態は葉から数えて決まるので、入れ物そのものを
 * 混ぜると同じことを 2 か所で決めることになる。
 */
export function effectiveOff(
  rows: PlanRow[],
  decisions: Decisions,
  done: Done = NOTHING_DONE,
): ReadonlySet<string> {
  const { passed } = duplicatePicks(rows, decisions, done);
  const off = new Set<string>(passed);
  for (const row of rows) {
    if (isLeaf(row) && !isOn(row, decisions)) off.add(row.id);
  }
  return off;
}

/**
 * 同じ巻の本の組（#166）。整理済みの本、巻数の読めない本、巻数を直した本は
 * 入れない。
 *
 * 整理済みの本は既定で外れていて（``defaultsOn``）、巻数の読めない本どうしは
 * 同じ巻かどうかが分からない。巻数を直した本は、直した本人が作るつもりで
 * いる。黙って外さず、重なれば「巻数が重なる」で知らせる。読み違えで同じ巻に
 * 入っていた本も、正しい巻に直せば組を抜けて入る。
 *
 * 組は巻数だけで作る。整理済みでない本は、どれも左の列の作品名と著者で
 * 名付けられるので、巻数が同じなら名前も同じになる。
 */
function volumeGroups(rows: PlanRow[]): PlanRow[][] {
  const groups = new Map<number, PlanRow[]>();
  for (const row of rows) {
    if (row.kind !== "book" || row.organized || row.volume === null) continue;
    if (row.volume !== row.autoVolume) continue;
    groups.set(row.volume, [...(groups.get(row.volume) ?? []), row]);
  }
  return [...groups.values()].filter((members) => members.length > 1);
}

/** 利用者が、その行にも、それを含む入れ物にも触っていないか */
function undecided(row: PlanRow, decisions: Decisions): boolean {
  return (
    !decisions.has(row.id) &&
    row.ancestors.every((ancestor) => !decisions.has(ancestor))
  );
}

/**
 * 同じ巻の本のうち、既定で入れる 1 冊と、既定で外す残り（#166）。
 *
 * 同じ巻が大量に出たとき、要らない方を 1 つずつ外すのは手間が大きい。既定で
 * 1 冊だけを選んでおき、利用者は残したい本を足すか、選ばれた本を外して別の本に
 * 替えるだけで済むようにする。
 *
 * - 選ぶのは、利用者がまだ触っていない本のうち、ファイルの一番大きい本。大きい
 *   方が画質の良い傾向にある。大きさの分からない本は後回し、同じなら一覧の上の方
 * - 組の中に利用者が入れた本があれば、既定では選ばない。入れた本が残る
 * - 利用者が外した本は選ばない。選ばれた本を外すと、次に大きい本が選ばれる。
 *   全部外せば、その巻は 1 冊も作らない
 * - 出来ている本（出力先に既にある本・この画面で作った本）が組にあれば、それを
 *   残す 1 冊と見て、今回の本は選ばない（#178）
 */
function duplicatePicks(
  rows: PlanRow[],
  decisions: Decisions,
  done: Done = NOTHING_DONE,
): { picked: ReadonlySet<string>; passed: ReadonlySet<string> } {
  const picked = new Set<string>();
  const passed = new Set<string>();
  for (const members of volumeGroups(rows)) {
    const open = members.filter(
      (row) => !done.has(row.id) && undecided(row, decisions),
    );
    const chosen = members.some(
      (row) =>
        done.has(row.id) ||
        (!undecided(row, decisions) && isOn(row, decisions)),
    );
    const best = chosen
      ? undefined
      : open.reduce<PlanRow | undefined>(
          (top, row) =>
            top === undefined || (row.size ?? -1) > (top.size ?? -1)
              ? row
              : top,
          undefined,
        );
    for (const row of open) {
      if (row === best) picked.add(row.id);
      else passed.add(row.id);
    }
  }
  return { picked, passed };
}

/**
 * 同じ巻の本に触る前に、いま既定で選ばれている 1 冊を「入れた」と覚える（#166）。
 *
 * 覚えないと、利用者が別の本を入れた途端に組に「入れた本」ができ、既定の 1 冊が
 * 外れる。1 冊足したつもりが入れ替えになる。外すときに覚えても同じ結果になる
 * （外した本はその場で外したと上書きされ、残りは既定のまま選び直される）ので、
 * 入れるときだけ呼べばよい。
 */
export function keepPicked(
  rows: PlanRow[],
  decisions: Decisions,
  leaves: string[],
  done: Done = NOTHING_DONE,
): Decisions {
  const { picked } = duplicatePicks(rows, decisions, done);
  const touched = new Set(leaves);
  const next = new Map(decisions);
  for (const members of volumeGroups(rows)) {
    if (!members.some((row) => touched.has(row.id))) continue;
    for (const row of members) if (picked.has(row.id)) next.set(row.id, true);
  }
  return next;
}

/**
 * 同じ巻の本が、どの巻も 1 冊以下しか入っていないか（#169）。主操作の行の
 * 「同じ巻は 1 冊」のチェックが読む。同じ巻の本が無ければ null。出来ている本は
 * 残る本として数える（#178）
 */
export function oneEachState(
  rows: PlanRow[],
  off: ReadonlySet<string>,
  done: Done = NOTHING_DONE,
): boolean | null {
  const groups = volumeGroups(rows);
  if (groups.length === 0) return null;
  return groups.every(
    (members) =>
      members.filter((row) => !off.has(row.id) || done.has(row.id)).length <= 1,
  );
}

/**
 * 同じ巻の本をまとめて切り替える（#169）。
 *
 * - ``one`` が true: 2 冊以上入っている巻を、入っている中で一番大きい 1 冊に
 *   絞る。1 冊も入っていない巻は、利用者が外したものなのでそのまま。出来ている
 *   本がある巻は、それを残して今回の本を全部外す（#178）
 * - ``one`` が false: 同じ巻の本を全部入れる
 */
export function setOneEach(
  rows: PlanRow[],
  decisions: Decisions,
  one: boolean,
  done: Done = NOTHING_DONE,
): Decisions {
  const groups = volumeGroups(rows);
  if (!one) {
    const leaves = groups
      .flat()
      .filter((row) => !done.has(row.id))
      .map((row) => row.id);
    return toggleLeaves(
      keepPicked(rows, decisions, leaves, done),
      leaves,
      true,
    );
  }
  const off = effectiveOff(rows, decisions, done);
  let next = decisions;
  for (const members of groups) {
    const kept = members.filter((row) => !off.has(row.id) && !done.has(row.id));
    if (members.some((row) => done.has(row.id))) {
      next = toggleLeaves(
        next,
        kept.map((row) => row.id),
        false,
      );
      continue;
    }
    if (kept.length < 2) continue;
    const best = kept.reduce((top, row) =>
      (row.size ?? -1) > (top.size ?? -1) ? row : top,
    );
    // 残す 1 冊も入れたと覚える。触っていないままだと、外した本と同じ巻の
    // 別の本が既定で選び直される
    next = toggleLeaves(next, [best.id], true);
    next = toggleLeaves(
      next,
      kept.filter((row) => row !== best).map((row) => row.id),
      false,
    );
  }
  return next;
}

/**
 * 付け外しでまとめて動かす鍵。行そのものと、その下の葉。
 *
 * 行そのものを混ぜるのは、子がまだ無い入れ物のため。後から本が生えると葉が
 * 入れ替わるので、入れ物の鍵でも覚えておかないと外したことが伝わらない。
 */
export function toggleTargets(row: PlanRow): string[] {
  return [row.id, ...row.leaves];
}

/** 葉の集まりの三態。全部残っていれば true、全部外れていれば false */
function stateOfLeaves(leaves: string[], off: ReadonlySet<string>): CheckState {
  const kept = leaves.filter((leaf) => !off.has(leaf)).length;
  if (kept === 0) return false;
  if (kept === leaves.length) return true;
  return "indeterminate";
}

/** 行の三態。下の一部だけが残っていれば混在になる */
export function checkStateOf(
  row: PlanRow,
  off: ReadonlySet<string>,
  done: Done = NOTHING_DONE,
): CheckState {
  return stateOfLeaves(
    row.leaves.filter((leaf) => !done.has(leaf)),
    off,
  );
}

/** 一覧全体の三態。主操作の行に置くチェックが読む */
export function masterCheckState(
  rows: PlanRow[],
  off: ReadonlySet<string>,
  done: Done = NOTHING_DONE,
): CheckState {
  return stateOfLeaves(
    allLeaves(rows).filter((leaf) => !done.has(leaf)),
    off,
  );
}

/** 一覧に出ている葉すべて。重複はこの時点で落とす */
function allLeaves(rows: PlanRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.leaves))];
}

/**
 * 指定した葉をまとめて残す / 外した、新しい決定の台帳を返す。
 *
 * 入れたことも外したことも値として書き込む。消して「載っていない＝外した」と
 * すると、既定でオフの本を入れ直したことが表せない（消した瞬間に既定のオフへ
 * 戻り、クリックが何も起きなかったように見える）。
 *
 * 元の台帳には触らない。書き換えると、同じ台帳を見ている描画が更新前の
 * 状態と区別できなくなる。
 */
export function toggleLeaves(
  decisions: Decisions,
  leaves: string[],
  keep: boolean,
): Decisions {
  const next = new Map(decisions);
  for (const leaf of leaves) {
    // 入れた順を台帳の並びで覚える。同じ巻を複数残したときの _1 の付け方に
    // 使う（#166）。既に入っている行は並びを動かさない
    if (keep && next.get(leaf) !== true) next.delete(leaf);
    next.set(leaf, keep);
  }
  return next;
}

/**
 * 残っている本。「N 冊を作ります」の N はこれで数える。
 *
 * ``keptBooks`` ・ ``droppedBookCount`` ・ ``organizedSkippedCount`` の 3 つで
 * 本の行を過不足なく分け合う。どれかに二重に数えられると、状態の行に出る
 * 内訳の合計が本の冊数と合わなくなる。
 */
export function keptBooks(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): PlanRow[] {
  return rows.filter((row) => row.kind === "book" && !off.has(row.id));
}

/**
 * 利用者が外した本の数。
 *
 * 整理済みの本は数えない。既定でオフなのは利用者の操作ではないので、
 * 「外した」に混ぜると何も触っていないのに外した覚えのない件数が出る。
 */
export function droppedBookCount(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): number {
  return rows.filter(
    (row) => row.kind === "book" && off.has(row.id) && !row.organized,
  ).length;
}

/**
 * 整理済みなので作らない本の数（#73 段階 4b）。
 *
 * 利用者が外した本とは理由が違うので、別の言葉で数える。入れ直せば作るので、
 * 整理済みでも入っている本はここに数えない。
 */
export function organizedSkippedCount(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): number {
  return rows.filter(
    (row) => row.kind === "book" && row.organized && off.has(row.id),
  ).length;
}

/** 残っている本に付いた印を、種類ごとに数える。外した本は数えない */
export function keptIssueCounts(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): { issue: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of keptBooks(rows, off)) {
    for (const issue of row.issues) {
      counts.set(issue, (counts.get(issue) ?? 0) + 1);
    }
  }
  return [...counts].map(([issue, count]) => ({ issue, count }));
}

/**
 * 残っている葉の行。実際に何かが作られる単位はこれだけ。
 *
 * 投入に載せる本（``selectedBooks``）と、左の列が要るかどうか
 * （``needsSeriesName``）は必ずこれを通す。別々に数えると、名前は要らないと
 * 言いながら名前を持たない本が投入に載り、``[] .zip`` が出来る。
 */
export function keptLeafRows(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): PlanRow[] {
  return rows.filter((row) => isLeaf(row) && !off.has(row.id));
}

/**
 * その行が、自分の名前（作品名と著者の対）を持っているか（#73 段階 4a）。
 *
 * 片方だけでは持っていないものとして扱う。半分だけの名前をサイドカーへ送ると
 * 断られるし、無視されれば左の列とも本自身とも違う名前のファイルが出来る。
 * サイドカーは対でしか返さないので、片方だけになるのは欄が届かなかったときで、
 * そのときに欲しいのは「いままでどおり左の列で作る」振る舞い。
 */
function carriesOwnName(row: PlanRow): boolean {
  return row.title !== "" && row.author !== "";
}

/**
 * 残した葉のうち、自分の名前を持たないもの。左の列の対はこの行のために要る。
 *
 * 入れ物の葉（目次を読めなかったアーカイブ・裸の画像フォルダ）も数える。
 * 中身は実行して初めて分かるので、依頼の対から名前を作るしかない。
 */
export function namelessKeptRows(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): PlanRow[] {
  return keptLeafRows(rows, off).filter((row) => !carriesOwnName(row));
}

/** 左の列（作品名と著者）が要るか。1 行でも名前を持たない行が残っていれば要る */
export function needsSeriesName(
  rows: PlanRow[],
  off: ReadonlySet<string>,
): boolean {
  return namelessKeptRows(rows, off).length > 0;
}

/**
 * 整理の投入に載せる「作る本」の一覧。
 *
 * 目次を読めなかったアーカイブは位置が分からないので、位置を空にして
 * アーカイブごと指す。サイドカーは解析で予告できた本だけを外すので、
 * 読めなかったものは今までどおり中身を全部作る。
 *
 * 自分の名前を持つ本には、その名前を添える。添えないと、整理済みの本まで
 * 左の列の対で作り直され、一覧の予告と出来上がりが食い違う。持たない本は
 * ``null`` を載せる。空文字は「名前が無い」ではなく「著者名が空の本」として
 * 通ってしまい、``[] `` で始まる本が出来る。
 *
 * 巻数は**直した本だけ**に包んで載せる（段階 5）。直していない本に
 * ``volume`` を載せると、サイドカーはそれを訂正として読み、既定の依頼が
 * 「全冊の巻数を書き換える」依頼になる。整理済みの本は直せない。
 */
export function selectedBooks(
  rows: PlanRow[],
  off: ReadonlySet<string>,
  volumes: ReadonlyMap<string, number | null> = new Map(),
  names: ReadonlyMap<string, string> = new Map(),
): {
  source: string;
  entry: string;
  title: string | null;
  author: string | null;
  volume?: { number: number | null };
  suffix?: number;
}[] {
  return keptLeafRows(rows, off).map((row) => {
    if (row.kind !== "book")
      return { source: row.path, entry: "", title: null, author: null };
    const book = {
      source: row.source,
      entry: row.entry,
      title: carriesOwnName(row) ? row.title : null,
      author: carriesOwnName(row) ? row.author : null,
    };
    // 整理済みの本は自分の名前のまま置き直すので、番号も訂正も載せない
    if (row.organized) return book;
    // 一覧に予告した _1 などの番号（#166）。載せないと、サイドカーは処理した順に
    // 番号を付け、選んだ順とも一覧の予告とも違う名前になる
    const suffix = nameSuffix(names.get(row.id));
    const named = suffix === null ? book : { ...book, suffix };
    if (!volumes.has(row.id)) return named;
    return { ...named, volume: { number: volumes.get(row.id) ?? null } };
  });
}

/**
 * 出来上がるファイル名を組み立てる。
 *
 * サイドカーの ``VolumeDetector.format_volume_name`` と同じ規則を写している。
 * 写しているのは、左列の作品名や著者を変えたときに一覧の名前が往復なしで
 * 追従する必要があるため。往復させると、数百件のアーカイブを入れた状態で
 * 1 文字打つたびに目次を読み直すことになる。
 *
 * 判断の難しい部分（巻数をどこから読むか）はサイドカーが決めた ``volume`` を
 * そのまま使うので、ここに写っているのは並べ方だけになる。
 */
export function formatVolumeName(
  author: string,
  title: string,
  volume: number | null,
): string {
  const base = `[${author}] ${title}`;
  if (volume === null) return `${base} Unknown`;
  return `${base} 第${String(volume).padStart(3, "0")}巻`;
}

/**
 * 一覧に出す名前を、行の鍵ごとに決める。
 *
 * 同じ名前がぶつかったら ``_1`` から番号を足す。足す順は**選んだ順**（#166）。
 * 既定で入っている本（同じ巻なら既定で選ばれた 1 冊）が先で、利用者が入れた
 * 本はその後に入れた順で続く。残したのが 1 冊なら番号は付かない。番号は
 * 整理の依頼に載せ（``selectedBooks``）、サイドカーもその名前で書き出す。
 *
 * 自分の名前を持つ本（整理済み）は、その名前で組み立てる（#73 段階 4a）。
 * 左の列の対で組み直すと、一覧には「作り直したら別人名義になる」という嘘の
 * 予告が並ぶ。サイドカーが返した ``output_name`` をそのまま使わないのは、
 * 左の列を変えたときに一覧が往復なしで追従する必要があるのと、あちらの
 * ``_1`` が別の帳簿（解析に投入した全件）で決まっているため。
 *
 * 外した本は名前を取らない（段階 5）。作られない本が名前を取ると、後ろの本に
 * 付くはずのない ``_1`` を予告することになる。外した本の行には、取らないまま
 * 組み立てた名前を出す。
 *
 * ``taken`` は出来ている本（出力先に既にある本・この画面で作った本）の名前
 * （#178）。先着として番号を持っているので、今回の本はその空きから取る。
 * 数えないと、実際には上書きを避けて別の番号で出来上がり、予告と食い違う。
 */
export function outputNames(
  rows: PlanRow[],
  author: string,
  title: string,
  off: ReadonlySet<string> = new Set(),
  decisions: Decisions = new Map(),
  taken: Iterable<string> = [],
): Map<string, string> {
  // 利用者が入れた本は、台帳に入れた順の位置で並べる。既定で入っている本は先頭
  const order = new Map(
    [...decisions.keys()].map((key, index) => [key, index]),
  );
  const rank = (row: PlanRow) =>
    decisions.get(row.id) === true ? (order.get(row.id) ?? -1) : -1;
  const books = rows.filter((row) => row.kind === "book");
  const kept = books
    .filter((row) => !off.has(row.id))
    .sort((a, b) => rank(a) - rank(b));
  const used = new Set<string>(taken);
  const names = new Map<string, string>();
  for (const row of kept) {
    const base = baseNameOf(row, author, title);
    let name = `${base}.zip`;
    for (let counter = 1; used.has(name); counter += 1) {
      name = `${base}_${counter}.zip`;
    }
    used.add(name);
    names.set(row.id, name);
  }
  for (const row of books) {
    if (!names.has(row.id))
      names.set(row.id, `${baseNameOf(row, author, title)}.zip`);
  }
  return names;
}

/** 名前に足した ``_1`` などの番号。無ければ null（名前は ``formatVolumeName`` の形） */
function nameSuffix(name: string | undefined): number | null {
  const found = name?.match(/_(\d+)\.zip$/);
  return found ? Number(found[1]) : null;
}

/**
 * 同じ巻の本の数（#162）。2 冊以上ある巻の本の行だけを載せる。
 *
 * チェックの有無に関わらず数える。外した方を数えないと、要らない方を外した
 * 途端に、同じ巻が他にもあることが見えなくなる。巻数の読めない本（Unknown）は
 * 数えない。そちらは「巻数が読めません」が既に言う。
 */
export function sameVolumeCounts(
  rows: PlanRow[],
  author: string,
  title: string,
): Map<string, number> {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "book" || row.volume === null) continue;
    const base = baseNameOf(row, author, title);
    groups.set(base, [...(groups.get(base) ?? []), row.id]);
  }
  const counts = new Map<string, number>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) counts.set(id, ids.length);
  }
  return counts;
}

/** 本の行の、``_1`` を足す前の名前 */
function baseNameOf(row: PlanRow, author: string, title: string): string {
  return carriesOwnName(row)
    ? formatVolumeName(row.author, row.title, row.volume)
    : formatVolumeName(author, title, row.volume);
}

/**
 * 作る本どうしで同じ名前になる本（段階 5）。重なった全部の行を返す。
 *
 * 後ろの本だけでなく前の本にも印を付ける。どちらの巻数が誤りかは画面には
 * 分からず、片方だけに付けると「印の無い方が正しい」と読まれる。巻数の
 * 読めない本（Unknown）は数えない。そちらは「巻数が読めません」が既に言う。
 *
 * 出来ている本（#178）とも重なりを見る。返すのは作る本の行だけ。
 */
export function collidingBooks(
  rows: PlanRow[],
  off: ReadonlySet<string>,
  author: string,
  title: string,
  done: Done = NOTHING_DONE,
): ReadonlySet<string> {
  const holders = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind !== "book" || row.volume === null) continue;
    if (off.has(row.id) && !done.has(row.id)) continue;
    const base = baseNameOf(row, author, title);
    holders.set(base, [...(holders.get(base) ?? []), row.id]);
  }
  return new Set(
    [...holders.values()]
      .filter((ids) => ids.length > 1)
      .flat()
      .filter((id) => !done.has(id)),
  );
}
