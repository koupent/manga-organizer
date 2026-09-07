import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarClient } from "../api/client";

export type Entry = { title: string; author: string };

/** 検索で見つかった作品と著者。近い順に並ぶ */
export type Candidate = {
  title: string;
  author: string;
  source: string;
  similarity: number;
};

/** 著者をどこから持ってきたか。元の実装と同じく、辞書由来は色を変えて示す */
export type AuthorSource = "" | "library" | "search";

/** 何文字目から自動で著者を探しに行くか。元の実装と同じ */
const MIN_SEARCH_LENGTH = 2;

/** 打つたびに問い合わせないための待ち時間 */
const SEARCH_DELAY_MS = 400;

/**
 * 作品名から著者を引く一式。
 *
 * 辞書の読み込み・打ち直しの間引き・遅れて届いた検索結果の握り潰しは、
 * どれか 1 つでも欠けると古い著者が新しい入力を上書きする。3 つまとめて
 * ここに閉じ込め、外からは決まった値と操作だけを見せる。
 */
export function useAuthorLookup(client: SidecarClient) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [authorSource, setAuthorSource] = useState<AuthorSource>("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);

  // 打ち直しの途中で古い検索結果が届いても無視できるようにする
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  // 利用者が著者を決めたか。決めた後に遅れて届いた検索結果で上書きしないため
  const authorChosen = useRef(false);

  // 画面が消えた後の state 更新を止める。この画面は消えるときにしか
  // 止まらないので、印は真偽値ひとつで足りる。作り直されたときのために
  // 効果の入口で伏せ直す
  const gone = useRef(false);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      // 待っている間に画面が消えたら、問い合わせは投げない
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const loadEntries = useCallback(() => {
    client
      .knownEntries()
      .then((payload) => {
        if (gone.current) return;
        setEntries(payload.entries);
      })
      .catch(() => undefined);
  }, [client]);

  useEffect(loadEntries, [loadEntries]);

  /**
   * 作品名が変わったら著者を引き直す。
   *
   * 辞書に完全一致があれば即座に埋める。無ければ少し待ってから外部検索する。
   * 古い作品名の著者が残らないよう、まず空にする。
   */
  const changeTitle = (next: string) => {
    setTitle(next);
    setAuthor("");
    setAuthorSource("");
    setCandidates([]);
    setSearching(false);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    authorChosen.current = false;

    const known = entries.find((entry) => entry.title === next);
    if (known?.author) {
      setAuthor(known.author);
      setAuthorSource("library");
      return;
    }
    if (next.trim().length < MIN_SEARCH_LENGTH) return;

    setSearching(true);
    searchTimer.current = setTimeout(() => {
      client
        .suggestAuthor(next)
        .then((found) => {
          if (gone.current || seq !== searchSeq.current) return;
          // 選び直す助けになるので、候補そのものは著者を決めた後でも出す
          setCandidates(found.candidates ?? []);
          // 近い順に並ぶので、先頭をそのまま入れて残りは候補に出す。
          // ただし利用者が先に決めていれば、遅れて届いた答えで覆さない
          if (found.author && !authorChosen.current) {
            setAuthor(found.author);
            setAuthorSource("search");
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (gone.current || seq !== searchSeq.current) return;
          setSearching(false);
        });
    }, SEARCH_DELAY_MS);
  };

  /** 著者を手で打つ。辞書から来た印は、打った時点で外す */
  const typeAuthor = (next: string) => {
    setAuthor(next);
    setAuthorSource("");
    authorChosen.current = true;
  };

  /** 検索結果の候補から著者を選ぶ */
  const chooseAuthor = (next: string) => {
    setAuthor(next);
    setAuthorSource("search");
    authorChosen.current = true;
  };

  return {
    entries,
    title,
    author,
    authorSource,
    candidates,
    searching,
    loadEntries,
    changeTitle,
    typeAuthor,
    chooseAuthor,
  };
}
