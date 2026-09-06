import { BookMarked, Library, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryImportResult, SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Empty } from "./ui/empty";
import { Input } from "./ui/input";
import { SectionTitle } from "./ui/section-title";

type Entry = { title: string; author: string };

/** 断られた 1 件を、辞書に残った著者と蔵書の著者の両方で言う */
type Conflict = LibraryImportResult["conflicts"][number];

function describeConflict(conflict: Conflict): string {
  const incoming = conflict.incoming_authors.join("・");
  // 辞書に残した著者があるなら、どちらが残ったのかまで言う。「押したのに
  // 変わらない」だけだと、辞書と蔵書のどちらが正しいのか確かめられない
  if (conflict.kept_author) {
    return (
      `${conflict.title}: 辞書の「${conflict.kept_author}」を残しました` +
      `（蔵書は「${incoming}」）`
    );
  }
  // 蔵書の中で著者が割れている場合。どちらかを勝手に選ぶと、以降の整理が
  // 選んだ覚えのない著者で埋まり続ける
  return `${conflict.title}: 蔵書の中で著者が「${incoming}」と食い違うため入れませんでした`;
}

type LibraryEditorProps = {
  client: SidecarClient;
  /**
   * 辞書へ入れられる、整理済みの蔵書の対。空なら取り込みの操作は出さない。
   *
   * 何を渡すかは呼ぶ側（OrganizePanel）が決める。ここは渡されたものを
   * 見せて送るだけで、辞書を引いて選り分け直すことはしない。
   */
  importable?: Entry[];
  /** 取り込みの応答。呼ぶ側が数え直せるように、そのまま渡す */
  onImported?: (result: LibraryImportResult) => void;
};

/**
 * タイトルと著者の辞書。元の Tkinter 版の DB 編集画面にあたる。
 *
 * 整理を確定すると自動で記録されるが、ここで直接直したり消したりできる。
 * 整理済みの蔵書をまとめて取り込む操作もここに置く。辞書のある場所で押せば、
 * 結果が同じ画面の行としてすぐ見えるうえ、整理を実行する操作から離れる。
 */
export function LibraryEditor({
  client,
  importable = [],
  onImported,
}: LibraryEditorProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [status, setStatus] = useState("");
  // 取り込みの応答。押すまでは無い。押した結果を残しておかないと、断られた
  // 対が何と食い違ったのか読む前に消える
  const [outcome, setOutcome] = useState<LibraryImportResult | null>(null);

  // 絞り込みは打つたびに問い合わせる。遅れて届いた古い結果で新しい絞り込みを
  // 覆さないよう、最後に投げた分だけを採用する
  const reloadSeq = useRef(0);

  const reload = useCallback(
    (search = "") => {
      const seq = ++reloadSeq.current;
      client
        .knownEntries(search)
        .then((payload) => {
          if (seq !== reloadSeq.current) return;
          setEntries(payload.entries as Entry[]);
        })
        .catch((reason) => {
          if (seq !== reloadSeq.current) return;
          setStatus(String(reason.message ?? reason));
        });
    },
    [client],
  );

  useEffect(() => reload(), [reload]);

  const save = async () => {
    if (!title.trim()) {
      setStatus("作品名を入れてください");
      return;
    }
    try {
      await client.saveEntry(title.trim(), author.trim());
      setStatus(`${title.trim()} を記録しました`);
      setTitle("");
      setAuthor("");
      reload(query);
    } catch (reason) {
      setStatus(String((reason as Error).message ?? reason));
    }
  };

  /**
   * 整理済みの蔵書を、まとめて辞書へ入れる。
   *
   * 入れる先を決めるのはサイドカー側。辞書に無い作品名だけが足され、既に
   * ある著者は上書きされない。画面が「無いものだけ」を選んで 1 件ずつ書く
   * ことはしない。一覧は新しい順の一部しか返らないので、それを超える辞書
   * では在るものが「無い」と見え、手で直した著者を潰してしまう。
   */
  const bringIn = async () => {
    setStatus("整理済みの蔵書を取り込んでいます...");
    try {
      const result = await client.importEntries(importable);
      setOutcome(result);
      setStatus(`${result.imported.length} 件を辞書に入れました`);
      reload(query);
      onImported?.(result);
    } catch (reason) {
      setStatus(String((reason as Error).message ?? reason));
    }
  };

  const remove = async (entry: Entry) => {
    try {
      await client.deleteEntry(entry.title);
      setStatus(`${entry.title} を削除しました`);
      reload(query);
    } catch (reason) {
      setStatus(String((reason as Error).message ?? reason));
    }
  };

  const suggest = async () => {
    if (!title.trim()) return;
    setStatus("調べています...");
    try {
      const found = await client.suggestAuthor(title.trim());
      if (found.author) {
        setAuthor(found.author);
        setStatus(`著者を補完しました: ${found.author}`);
      } else {
        setStatus("著者が見つかりませんでした");
      }
    } catch (reason) {
      setStatus(String((reason as Error).message ?? reason));
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionTitle>辞書</SectionTitle>
        <span
          className="tabular text-[12px] text-ink-faint"
          data-testid="entry-count"
        >
          {entries.length} 件
        </span>
        <div className="flex-1" />
        <span
          className="text-[12px] text-ink-muted"
          data-testid="library-status"
        >
          {status}
        </span>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-medium text-ink-muted">
              作品名
            </span>
            <Input
              data-testid="new-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="flex min-w-[160px] flex-1 flex-col gap-1">
            <span className="text-[11.5px] font-medium text-ink-muted">
              著者
            </span>
            <Input
              data-testid="new-author"
              value={author}
              onChange={(event) => setAuthor(event.target.value)}
            />
          </label>
          <Button
            variant="ghost"
            data-testid="library-suggest"
            onClick={suggest}
          >
            <Search />
            著者を調べる
          </Button>
          <Button
            variant="primary"
            size="lg"
            data-testid="library-save"
            onClick={save}
          >
            <Plus />
            記録する
          </Button>
        </CardBody>
      </Card>

      {/*
        取り込みは、入れられる対があるときだけ出す。入れるものが無いのに
        残っていると、押しても何も起きない操作が画面に居座る。
      */}
      {importable.length > 0 && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-ink-muted">
              整理済みの蔵書に、辞書がまだ覚えていない作品があります
            </span>
            <div className="flex-1" />
            <Button
              variant="secondary"
              data-testid="library-import"
              data-count={importable.length}
              onClick={bringIn}
            >
              <Library />
              {importable.length} 件を辞書に入れる
            </Button>
          </CardBody>
        </Card>
      )}

      {outcome && (
        <Card data-testid="library-import-result">
          <CardBody className="flex flex-col gap-1 text-[12px]">
            <span className="text-ink-muted">
              {outcome.imported.length} 件を入れました ·{" "}
              {outcome.unchanged.length} 件は既にありました ·{" "}
              {outcome.conflicts.length} 件は入れませんでした
            </span>
            {outcome.conflicts.map((conflict) => (
              <span
                key={conflict.title}
                data-testid="library-import-conflict"
                data-title={conflict.title}
                className="text-danger"
              >
                {describeConflict(conflict)}
              </span>
            ))}
          </CardBody>
        </Card>
      )}

      <div className="flex items-center gap-2">
        <Search className="size-3.5 text-ink-faint" />
        <Input
          className="max-w-xs"
          data-testid="library-search"
          placeholder="作品名で絞り込む"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            reload(event.target.value);
          }}
        />
      </div>

      {entries.length === 0 ? (
        <Empty icon={<BookMarked />} title="辞書は空です">
          作品名と著者を記録しておくと、整理のときに候補として出ます。
        </Empty>
      ) : (
        <Card>
          <CardHeader className="text-[11.5px] font-medium text-ink-muted">
            <span className="flex-[2]">作品名</span>
            <span className="flex-1">著者</span>
            <span className="w-6" />
          </CardHeader>
          <ul className="max-h-[26rem] divide-y divide-line/50 overflow-y-auto">
            {entries.map((entry) => (
              <li
                key={entry.title}
                data-testid="library-entry"
                data-title={entry.title}
                data-author={entry.author}
                className="group flex items-center gap-2 px-2 py-0.5 hover:bg-surface-2"
              >
                <span className="flex-[2] truncate text-[12.5px]">
                  {entry.title}
                </span>
                <span className="flex-1 truncate text-[12.5px] text-ink-muted">
                  {entry.author || "—"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="library-delete"
                  title="削除"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={() => remove(entry)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
