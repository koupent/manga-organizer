"""加工前の元画像を ZIP の中に残し、加工後の画像から引けるようにする（#66）。

サムネイル作成で切り抜くと元の画素が失われ、範囲を広げる方向へは戻せない。
そこで加工を確定するときに加工前の画像を同じ ZIP の中へ同梱し、
「加工後の画像 -> 元画像 + 施した加工」を manifest に書き残す。

    .manga-organizer/
      originals/
        <content hash>.jpg   加工前の画像そのもの
      manifest.json          加工後のハッシュ -> 元 + 施した加工

名前ではなく中身のハッシュで紐づけるのが要点。サムネイル作成もページ並べ替えも
整理もエントリ名を変えるが、画像の中身は変えない。名前で紐づけると連番の
振り直しで即座に切れる。

ハッシュを SHA-256 に固定しているのは、画面側（TypeScript / Rust）が同じ値を
計算して manifest を引く必要があるため。アルゴリズムまでが公開契約になる。

置き場をドットフォルダにしているのは viewer にページとして拾わせないため。
`viewer_contract` がパスの全要素でドット判定するようになっていることが前提で、
そうでないと元画像がページ扱いされ、並べ替えで改名されて失われる。

manifest の向き
------------------------------------------------------------------
記録は「加工後 -> 元」の向きに持つ。逆向き（元 -> 加工後）にすると、
1 つの元から複数の加工後が出る形（#58 の見開き分割は 1 枚から 2 枚）で
値が配列になり、加工後から元を引く主用途で毎回走査が要る。
加工後のハッシュを鍵にすれば、複数の記録が同じ元を指すだけで表せる。

2 回加工した画像の「元」は 1 回目の加工結果になる。記録は 1 段ずつ持ち、
引くときに記録が途切れるまで遡ることで、常に本当の元画像へ行き着く。
中間結果そのものは保存しない（遡れれば足りるうえ、加工のたびに増える）。
"""

import hashlib
import json
import logging
import zipfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from manga_core.viewer_contract import is_page_source

logger = logging.getLogger(__name__)

# 元画像の置き場と紐づけの記録。画面側もこの名前を直接見る
ORIGINALS_PREFIX = ".manga-organizer/originals/"
MANIFEST_ENTRY = ".manga-organizer/manifest.json"

# manifest の形式が変わったときに見分けるための版番号
MANIFEST_VERSION = 1

# 展開する前に拒む大きさの上限。ZIP は同じ並びをほとんど無に圧縮できるので、
# 数百 KB の書庫が展開すると数百 MiB になる。利用者は書庫をどこからでも
# 手に入れるうえ、サムネイル画面は開いただけで manifest と元画像を読む。
# 展開してから大きさを見たのでは、その一瞬で確保してしまい遅い。
# ここは「まっとうな本ならまず超えない」値で、記録の JSON は数十 KB、
# 1 ページの画像は数 MiB に収まる
MANIFEST_SIZE_LIMIT = 4 * 1024 * 1024
ORIGINAL_SIZE_LIMIT = 64 * 1024 * 1024

# 読み出せなかったときに外へ出す説明。ZIP 内のどのエントリを読もうとしたかは
# 混ぜない。書き換えられた manifest から、アーカイブ内の何が読めたかを
# 画面越しに探れてしまう。診断に要る名前はログへ残す
_UNREADABLE_MESSAGE = "元画像を読み出せません"

_ORIGINALS_KEY = "originals"
_DERIVED_KEY = "derived"
_SOURCE_KEY = "source"
_OPERATIONS_KEY = "operations"

# 拡張子を持たない画像エントリの置き場名。中身は元のバイト列そのもの
_FALLBACK_SUFFIX = ".bin"


class OriginalStoreError(RuntimeError):
    """元画像の記録を組み立てられない"""


@dataclass(frozen=True)
class Operation:
    """元画像に施した加工 1 つ分。

    kind は "crop" | "rotate"（#58 の見開き分割で "split" が加わる）。
    params の形は kind ごとに決まる。

        crop   -> {"box": [left, upper, right, lower]}
        rotate -> {"degrees": int}
        split  -> {"side": "left" | "right"}

    種類を増やすときは kind と params を足すだけで済むよう、params は
    形を固定せず素の写像で持つ。
    """

    kind: str
    params: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class OriginalRef:
    """遡れる限り遡った「本当の元画像」への参照"""

    hash: str
    entry: str
    operations: tuple[Operation, ...] = ()


def content_hash(data: bytes) -> str:
    """画像の中身そのものの SHA-256（16 進小文字）。

    名前は一切混ぜない。混ぜると連番の振り直しで値が変わり、紐づけが切れる。
    """
    return hashlib.sha256(data).hexdigest()


def original_entry_name(digest: str, source_name: str) -> str:
    """元画像を置くエントリ名。中身のハッシュで決まり、役割では決まらない。

    `original-cover` のように役割で名付けると、表紙が入れ替わったとき
    2 回目の加工で 1 回目の元画像を上書きして失う。
    """
    suffix = PurePosixPath(source_name).suffix.lower() or _FALLBACK_SUFFIX
    return f"{ORIGINALS_PREFIX}{digest}{suffix}"


def plan_record(
    archive_path: Path,
    source: bytes,
    source_name: str,
    produced: bytes,
    operations: Sequence[Operation] = (),
) -> dict[str, bytes]:
    """加工を確定するときに ZIP へ書き足すエントリを組み立てる。

    返すのは「エントリ名 -> バイト列」。呼び出し側は本体の書き直しと同じ
    1 回の書き込みでこれを流し込む。別々に書くと、元画像だけ書けて本体が
    古いままの中途半端なアーカイブが残りうるうえ、ZIP のタイムスタンプ保持も
    2 回目の書き込みで壊れる。

    実際に書き込むかどうかの判断（既に同じ中身が入っているか、遡れる中間結果か）
    はここに閉じる。呼び出し側は返ってきたものをそのまま書けばよい。
    """
    produced_hash = content_hash(produced)
    source_hash = content_hash(source)
    if produced_hash == source_hash:
        # 中身が変わっていない。記録すると自分自身を指して遡れなくなる
        return {}

    document = _load_document(Path(archive_path))
    originals = dict(document.get(_ORIGINALS_KEY, {}))
    derived = dict(document.get(_DERIVED_KEY, {}))

    extras: dict[str, bytes] = {}
    if source_hash not in derived and source_hash not in originals:
        # 遡れない画像が本当の元画像。中間結果は遡れるので保存しない
        entry = original_entry_name(source_hash, source_name)
        originals[source_hash] = entry
        extras[entry] = source

    derived[produced_hash] = {
        _SOURCE_KEY: source_hash,
        _OPERATIONS_KEY: [_operation_to_json(operation) for operation in operations],
    }

    extras[MANIFEST_ENTRY] = _dump_document(originals, derived)
    _reject_page_entries(extras)
    return extras


def find_original(archive_path: Path, image: bytes) -> OriginalRef | None:
    """加工後の画像の中身から、遡れる限り遡った元画像を返す。

    記録がなければ None。名前は一切見ないので、並べ替えで改名されても切れない。
    """
    document = _load_document(Path(archive_path))
    originals: Mapping[str, str] = document.get(_ORIGINALS_KEY, {})
    derived: Mapping[str, Mapping[str, object]] = document.get(_DERIVED_KEY, {})

    query = content_hash(image)
    current = query
    operations: list[Operation] = []
    seen = {current}
    while (record := derived.get(current)) is not None:
        # 遡りながら前へ足すことで、元画像から見た適用順に並ぶ
        operations = _operations_from_json(record) + operations
        current = str(record.get(_SOURCE_KEY, ""))
        if current in seen:
            # 壊れた manifest で無限に回らない
            return None
        seen.add(current)

    if current == query:
        # 1 段も遡れなかった。加工していない画像か、元画像そのもの
        return None
    entry = originals.get(current)
    if entry is None:
        return None
    return OriginalRef(hash=current, entry=entry, operations=tuple(operations))


def read_original(archive_path: Path, ref: OriginalRef) -> bytes:
    """元画像そのもののバイト列を読み出す。

    読み出したバイト列が記録どおりのハッシュになることを、ここで確かめる。
    紐づけは中身のハッシュで決まると謳っている以上、引く側が確かめないと
    誰も確かめない。manifest は ZIP の中にあり、本を配る側が自由に書ける。
    参照先だけを別のエントリへ向ければ、利用者が一度も見ていない絵が
    「加工前の画像」として画面に出るうえ、from_original を立てた確定は
    その画素へ切り抜きを当てて本文を上書きする。元は残らない。
    """
    path = Path(archive_path)
    data = _read_member(path, ref.entry, ORIGINAL_SIZE_LIMIT)
    if content_hash(data) != ref.hash:
        logger.warning(
            "元画像の中身が記録と食い違います: %s (%s)", ref.entry, path.name
        )
        raise OriginalStoreError(_UNREADABLE_MESSAGE)
    return data


def _read_member(path: Path, entry: str, limit: int) -> bytes:
    """アーカイブ内の 1 エントリを、申告された大きさを見てから読み出す。

    外へ出す説明はどの場合も同じにする。読めた・読めなかったの違いから
    ZIP の中身を探れないようにするため。捕まえる例外を絞っているのは、
    OriginalStoreError 自身が RuntimeError だから。広く捕まえると、
    上限で拒んだ判断まで握り潰す。
    """
    try:
        with zipfile.ZipFile(path, "r") as archive:
            declared = archive.getinfo(entry).file_size
            if declared > limit:
                logger.warning(
                    "展開後 %d バイトの申告で上限を超えています: %s (%s)",
                    declared,
                    entry,
                    path.name,
                )
                raise OriginalStoreError(_UNREADABLE_MESSAGE)
            try:
                with archive.open(entry) as member:
                    # 申告は書いてあるだけで、中身がその通りだとは限らない。
                    # 申告より 1 バイト多く読んで、食い違えばそこで止める。
                    # 全部読んでから確かめると、嘘の申告 1 つで数百 MiB 掴む
                    data = member.read(declared + 1)
            except (RuntimeError, NotImplementedError) as error:
                # 暗号化されたエントリ、zipfile が知らない圧縮方式。
                # ZIP としては整合しているので、開くまで分からない
                raise OriginalStoreError(_UNREADABLE_MESSAGE) from error
            if len(data) > declared:
                logger.warning(
                    "申告 %d バイトより中身が大きいエントリです: %s (%s)",
                    declared,
                    entry,
                    path.name,
                )
                raise OriginalStoreError(_UNREADABLE_MESSAGE)
            return data
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise OriginalStoreError(_UNREADABLE_MESSAGE) from error


def _reject_page_entries(extras: Mapping[str, bytes]) -> None:
    """書き足すエントリがページとして扱われないことを確かめる。

    ページ扱いされると連番の振り直しに巻き込まれ、元画像が本文へ混ざったうえ
    失われる。置き場を変えたときに気づけるよう、書き込む直前で止める。
    """
    pages = sorted(name for name in extras if is_page_source(name))
    if pages:
        raise OriginalStoreError(f"元画像の置き場がページとして扱われます: {pages}")


def _operation_to_json(operation: Operation) -> dict[str, object]:
    """Operation を manifest に書ける形へ落とす"""
    return {"kind": operation.kind, "params": dict(operation.params)}


def _operations_from_json(record: Mapping[str, object]) -> list[Operation]:
    """manifest の 1 記録から加工の並びを読み出す。壊れていれば読み飛ばす"""
    raw = record.get(_OPERATIONS_KEY)
    if not isinstance(raw, list):
        return []
    operations = []
    for item in raw:
        if not isinstance(item, dict) or "kind" not in item:
            continue
        params = item.get("params")
        operations.append(
            Operation(
                kind=str(item["kind"]),
                params=params if isinstance(params, dict) else {},
            )
        )
    return operations


def _load_document(archive_path: Path) -> dict:
    """アーカイブ内の manifest を読む。無い・壊れているときは空として扱う。

    manifest が読めないからといって加工そのものを止めると、既存のアーカイブを
    一切編集できなくなる。読めない記録は無かったことにして書き直す。

    読めない理由は JSON の壊れ方だけではない。暗号化された 1 エントリや
    知らない圧縮方式、展開すると膨れ上がる中身も「読めない」に含める。
    ページ自体は完全に読める本が、サムネイル画面を開いただけで落ちてしまう。
    """
    try:
        raw = _read_member(Path(archive_path), MANIFEST_ENTRY, MANIFEST_SIZE_LIMIT)
    except OriginalStoreError:
        return {}
    try:
        document = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return _normalized(document)


def _normalized(document: object) -> dict:
    """外から来た manifest を、以降が信じてよい形へ整える。

    ZIP は誰でも開いて書き換えられるので、期待した形である保証がない。
    崩れた形をそのまま持ち回ると、加工のたびに読み出し側で落ちる。
    読めない記録だけ落として、残りは使う。

    元画像の参照先を ORIGINALS_PREFIX 配下に限るのは、書き換えられた manifest
    から `read_original` にアーカイブ内の別のエントリを読ませないため。
    """
    if not isinstance(document, dict):
        return {}
    originals = {
        str(key): value
        for key, value in _as_dict(document.get(_ORIGINALS_KEY)).items()
        if isinstance(value, str) and value.startswith(ORIGINALS_PREFIX)
    }
    derived = {
        str(key): value
        for key, value in _as_dict(document.get(_DERIVED_KEY)).items()
        if isinstance(value, dict) and isinstance(value.get(_SOURCE_KEY), str)
    }
    return {_ORIGINALS_KEY: originals, _DERIVED_KEY: derived}


def _as_dict(value: object) -> dict:
    """写像でなければ空として扱う"""
    return value if isinstance(value, dict) else {}


def _dump_document(
    originals: Mapping[str, str], derived: Mapping[str, object]
) -> bytes:
    """manifest を書き出す。

    鍵を並べて書くのは、同じ内容なら同じバイト列にするため。差分が出ないと
    アーカイブの中身が無用に変わらず、変更の追跡もしやすい。
    """
    document = {
        "version": MANIFEST_VERSION,
        _ORIGINALS_KEY: dict(sorted(originals.items())),
        _DERIVED_KEY: dict(sorted(derived.items())),
    }
    text = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=False)
    return f"{text}\n".encode()
