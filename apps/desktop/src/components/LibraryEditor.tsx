import { BookMarked, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SidecarClient } from "../api/client";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Empty } from "./ui/empty";
import { Input } from "./ui/input";

type Entry = { title: string; author: string };

/**
 * タイトルと著者の辞書。元の Tkinter 版の DB 編集画面にあたる。
 *
 * 整理を確定すると自動で記録されるが、ここで直接直したり消したりできる。
 */
export function LibraryEditor({ client }: { client: SidecarClient }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [status, setStatus] = useState("");

  const reload = useCallback(
    (search = "") => {
      client
        .knownEntries(search)
        .then((payload) => setEntries(payload.entries as Entry[]))
        .catch((reason) => setStatus(String(reason.message ?? reason)));
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
        <h2 className="text-[13px] font-semibold">辞書</h2>
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
          <Button variant="primary" data-testid="library-save" onClick={save}>
            <Plus />
            記録する
          </Button>
        </CardBody>
      </Card>

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
            <span className="w-8" />
          </CardHeader>
          <ul className="max-h-[26rem] divide-y divide-line/50 overflow-y-auto">
            {entries.map((entry) => (
              <li
                key={entry.title}
                data-testid="library-entry"
                data-title={entry.title}
                className="group flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2"
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
