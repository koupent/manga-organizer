"""出力先に既にある本と、その番号の詰め直し（#178）。

整理の一覧は、出力先に前回作った同じ巻が残っていることを知らないと、番号なしや
``_1`` を予告しながら、実際には上書きを避けて ``_2`` で作ることになる。出力先の
本を一覧へ出し、番号を先着として数えられるようにする。

同じ巻を 1 冊に絞る使い方では、要らない方を消したあとに ``_2`` などが残る。残った
本を先着順に番号なし・``_1``・``_2`` と付け直すのが ``rename_files``。
"""

import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from manga_core.naming import natural_sort_key
from manga_core.volume_detector import format_series_dir

OUTPUT_SUFFIX = ".zip"


@dataclass(frozen=True)
class OutputBook:
    """出力先にある、整理の規則どおりの名前の本 1 冊"""

    path: Path
    # 巻数。``Unknown`` の本は None
    volume: int | None
    size: int


def list_output_books(
    output_directory: Path, author: str, title: str
) -> list[OutputBook]:
    """出力先の作品フォルダにある、整理の規則どおりの名前の本を並べる。

    規則に合わないファイル（手で置いた本・別の作品）は拾わない。番号を数える
    相手は、整理が作りうる名前だけでよい。フォルダがまだ無ければ空。
    """
    if not author.strip() or not title.strip():
        return []
    base = format_series_dir(author, title)
    pattern = re.compile(
        re.escape(base)
        + r" (?:第(\d{3,})巻|Unknown)(?:_\d+)?"
        + re.escape(OUTPUT_SUFFIX)
    )
    try:
        entries = list((output_directory / base).iterdir())
    except OSError:
        return []
    books: list[OutputBook] = []
    for path in entries:
        found = pattern.fullmatch(path.name)
        if found is None or not path.is_file():
            continue
        books.append(
            OutputBook(
                path=path,
                volume=int(found.group(1)) if found.group(1) else None,
                size=path.stat().st_size,
            )
        )
    return sorted(books, key=lambda book: natural_sort_key(book.path.name))


def rename_files(renames: list[tuple[Path, Path]]) -> None:
    """同じフォルダの中で、ファイルの名前をまとめて付け替える。

    ``_1`` → 番号なし、``_2`` → ``_1`` のように、付け替え先が別の付け替え元と
    重なる並びをそのまま受ける。いったん全部を仮の名前へ逃がしてから付け直す。
    途中で失敗したら、逃がしたものを元の名前へ戻してから例外を上げる。

    付け替え先に、付け替えないファイルが既にあれば断る（上書きしない）。
    """
    sources = [source for source, _ in renames]
    targets = [target for _, target in renames]
    if len(set(sources)) != len(sources) or len(set(targets)) != len(targets):
        raise ValueError("同じファイルを 2 度付け替えようとしています")
    for source, target in renames:
        if source.parent != target.parent:
            raise ValueError("付け替えは同じフォルダの中に限ります")
        if (
            target.suffix.lower() != OUTPUT_SUFFIX
            or source.suffix.lower() != OUTPUT_SUFFIX
        ):
            raise ValueError("付け替えられるのは ZIP だけです")
        if not source.is_file():
            raise ValueError(f"ファイルが見つかりません: {source.name}")
        if target.exists() and target not in sources:
            raise ValueError(f"同じ名前のファイルが既にあります: {target.name}")

    token = uuid.uuid4().hex
    parked: list[tuple[Path, Path, Path]] = []
    try:
        for source, target in renames:
            temporary = source.with_name(f".{source.name}.{token}")
            source.rename(temporary)
            parked.append((source, temporary, target))
    except OSError:
        _restore(parked)
        raise

    done: list[tuple[Path, Path, Path]] = []
    try:
        for entry in parked:
            source, temporary, target = entry
            if target.exists():
                raise FileExistsError(
                    f"同じ名前のファイルが既にあります: {target.name}"
                )
            temporary.rename(target)
            done.append(entry)
    except OSError:
        # 付け直した分も含めて、全部を元の名前へ戻す
        for _source, temporary, target in done:
            target.rename(temporary)
        _restore(parked)
        raise


def _restore(parked: list[tuple[Path, Path, Path]]) -> None:
    """仮の名前へ逃がしたファイルを、元の名前へ戻す"""
    for source, temporary, _ in reversed(parked):
        if temporary.exists():
            temporary.rename(source)
