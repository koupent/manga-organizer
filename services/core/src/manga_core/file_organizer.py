import logging
import os
import tempfile
import zipfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

from manga_core.archive_handler import ArchiveHandler
from manga_core.file_times import capture_file_times, restore_file_times
from manga_core.organized_detector import judge_organized
from manga_core.original_store import sidecar_members
from manga_core.volume_detector import SeriesName, VolumeDetector

logger = logging.getLogger(__name__)

# 整理が書き出す唯一の拡張子。``ArchiveHandler.create_archive`` は ZIP しか
# 書かない。行き先を先に組み立てる所（自分自身の上に来ていないかを見る）と、
# 実際に書き出す名前を決める所で別々に書くと、片方だけを直したときに
# 見張っている行き先と本当の行き先が食い違う
OUTPUT_SUFFIX = ".zip"

# 巻数の訂正が 1 つも無いときの地図（#114 段階 B）。書き換えられない物にして
# おくのは、既定値の辞書を呼び出し側が取り違えて書き換えると、1 回の実行の
# 訂正が次の実行へ漏れるため
NO_VOLUME_OVERRIDES: Mapping[str, int | None] = MappingProxyType({})
# 位置 -> 名前に足す番号（#166）。同じ巻を複数残したときに、画面が選んだ順に
# 決めた ``_1`` などを書き出す名前へ写す。番号を決めない本は載せない
NO_SUFFIXES: Mapping[str, int] = MappingProxyType({})

# フォルダを丸ごと 1 冊として扱うときの鍵。展開ルートからの相対パスが ``.``
# になる場合と同じ扱いで、``_location_key`` が返す値と 1 バイトも違わない
IMAGE_DIRECTORY_KEY = ""


@dataclass
class ProcessResult:
    original_path: Path
    output_path: Path | None
    success: bool
    error_message: str | None = None
    volume_number: int | None = None


# 1 冊を書き終えるたびに呼ぶ関数（#160）。結果と、その本の位置（``_location_key``
# と同じ鍵）を受け取る。整理が全部済むのを待たずに、出来た本から画面へ出すため
BookDone = Callable[[ProcessResult, str | None], None]


class FileOrganizer:
    def __init__(
        self, output_directory: Path, keep_originals: bool = True, log_callback=None
    ):
        self.output_directory = output_directory
        self.keep_originals = keep_originals
        self.log_callback = log_callback
        self.archive_handler = ArchiveHandler(log_callback=log_callback)
        self.volume_detector = VolumeDetector()
        self.results: list[ProcessResult] = []
        self.author = ""
        self.title = ""

    def _log(self, message: str, level: str = "info"):
        """Unified logging helper method"""
        if self.log_callback:
            self.log_callback(message)

        if level == "error":
            logger.error(message)
        elif level == "warning":
            logger.warning(message)
        else:
            logger.info(message)

    def set_manga_info(self, author: str, title: str):
        self.author = author
        self.title = title

    def _validate_and_extract_archive(
        self, archive_path: Path
    ) -> tuple[list[Path], str | None]:
        """Validate and extract archive, returning image directories and any error"""
        self._log("  Processing archive structure...")
        image_dirs, error = self.archive_handler.process_archive(archive_path)

        if error or not image_dirs:
            return [], error or "No images found"

        self._log(f"Found {len(image_dirs)} volumes in {archive_path.name}")
        return image_dirs, None

    def _create_manga_directory(self, series: SeriesName) -> Path:
        """Create output directory for manga series"""
        self._log("  Creating output directory for manga series...")
        manga_dir = self.output_directory / series.series_dir()
        manga_dir.mkdir(parents=True, exist_ok=True)
        return manga_dir

    def _detect_volume_number(
        self, image_dir: Path, archive_path: Path, vol_idx: int, total_dirs: int
    ) -> int | None:
        """Detect volume number using priority-based detection.

        優先順位そのものは VolumeDetector に置く。実行前の解析（#70）が同じ
        番号を出す必要があり、規則を 2 か所に書くと片方だけ直したときに
        予告した名前と実際に出来る名前が食い違うため。
        """
        return self.volume_detector.resolve_volume(
            image_dir, archive_path, vol_idx, total_dirs
        ).number

    def _process_volume(
        self,
        image_dir: Path,
        archive_path: Path,
        manga_dir: Path,
        volume: int | None,
        series: SeriesName,
        sole: bool,
        suffix: int | None = None,
    ) -> ProcessResult | None:
        """1 巻ぶんを書き出す。行き先が元のアーカイブ自身で、作り直す必要も
        無ければ ``None`` を返す。

        ``sole`` は、元のアーカイブから出る本がこの 1 冊だけかどうか。
        ``suffix`` は名前に足す番号（#166）。無ければ番号なしの名前から試す。
        """
        # Generate output filename
        output_name = series.volume_name(volume)

        # 行き先が元のアーカイブ自身なら、``_1`` の写しは作らない（#73 段階 4a）。
        # 既定の出力先は「投入した 1 件目の親フォルダ」なので、``蔵書/[著者] 作品``
        # を放り込むと出力先は ``蔵書`` になり、蔵書の本の行き先はその本自身に
        # なる。``get_unique_filename`` は既にある名前を返さないので、書きに行くと
        # ``…第003巻_1.zip`` が出来て元と写しが並び、``keep_originals=False`` なら
        # ``_handle_original_deletion`` が元を消す。利用者から見れば、蔵書の本が
        # 黙って別名になったまま戻せない。番号を振る前に見るのは、振ってしまうと
        # 行き先が必ず自分と違う名前になり、この一致が永久に起きないため
        destination = manga_dir / f"{output_name}{OUTPUT_SUFFIX}"
        if destination.resolve() == archive_path.resolve():
            if not sole or self._already_organized(archive_path):
                return None
            # 名前も置き場所も出来上がりなのに、中身（ページ名・同梱物）だけが
            # 違う本。飛ばすと、利用者が選んで整理したのに何も変わらず、印も
            # 残り続ける（#127）。同じ場所で作り直す
            return self._rebuild_in_place(image_dir, archive_path, volume)

        # 同じ巻を複数残したときは、画面が選んだ順に決めた番号で書き出す（#166）。
        # 処理した順に番号を付けると、一覧の予告とも選んだ順とも違う名前になる。
        # 出力先に同じ名前が既に在るときは、その番号から上へ空きを探す。番号なしの
        # 名前へは戻らない。そこは番号なしで選ばれた本の名前で、まだ書き出して
        # いないだけかもしれない
        if suffix:
            number = suffix
            while (manga_dir / f"{output_name}_{number}{OUTPUT_SUFFIX}").exists():
                number += 1
            output_path = manga_dir / f"{output_name}_{number}{OUTPUT_SUFFIX}"
        else:
            output_path = self.volume_detector.get_unique_filename(
                manga_dir, output_name, OUTPUT_SUFFIX
            )

        # Create new archive for this volume
        error = self._build_volume_archive(image_dir, output_path, volume)

        if error is None:
            self._log(f"Created: {output_path.name}")
            return ProcessResult(
                original_path=archive_path,
                output_path=output_path,
                success=True,
                volume_number=volume,
            )
        else:
            return ProcessResult(
                original_path=archive_path,
                output_path=None,
                success=False,
                error_message=error,
            )

    def _already_organized(self, archive_path: Path) -> bool:
        """自分自身の上に来た本が、既に整理の出力そのものかどうか。

        判定は解析と同じ ``judge_organized``。読めなければ整理済みと見て
        触らない側へ倒す。作り直しは元を置き換える操作なので、分からないまま
        進めない。
        """
        try:
            with zipfile.ZipFile(archive_path) as archive:
                names = archive.namelist()
        except (OSError, zipfile.BadZipFile):
            return True
        return judge_organized(archive_path, "", 1, names).organized

    def _rebuild_in_place(
        self, image_dir: Path, archive_path: Path, volume: int | None
    ) -> ProcessResult:
        """元のアーカイブを、整理の出力で置き換える（#127）。

        同じフォルダの一時ファイルへ書き、読み直して壊れていないと確かめて
        から置き換える。元は展開済みなので、置き換えた後に読む物は無い。
        途中で失敗したら元には触れず、一時ファイルだけを消す。

        ファイルの時刻は元のまま残す。蔵書の中の本を書き直す操作なので、
        ページ並べ替えやサムネイル作成と同じく、日付で並べた蔵書の並びを崩さない。
        """
        handle, raw = tempfile.mkstemp(
            dir=archive_path.parent,
            prefix=f".{archive_path.name}.organize-",
            suffix=".tmp",
        )
        os.close(handle)
        temp_path = Path(raw)
        try:
            error = self._build_volume_archive(image_dir, temp_path, volume)
            if error is None:
                error = _damaged(temp_path)
            if error is not None:
                return ProcessResult(
                    original_path=archive_path,
                    output_path=None,
                    success=False,
                    error_message=error,
                )
            times = capture_file_times(archive_path)
            os.replace(temp_path, archive_path)
            restore_file_times(archive_path, times)
        finally:
            temp_path.unlink(missing_ok=True)
        self._log(f"Rebuilt in place: {archive_path.name}")
        return ProcessResult(
            original_path=archive_path,
            output_path=archive_path,
            success=True,
            volume_number=volume,
        )

    def _build_volume_archive(
        self, image_dir: Path, output_path: Path, volume: int | None
    ) -> str | None:
        """1 巻ぶんの本を書き出す。失敗したらその理由を返す。

        本文を書いてから同梱物を足す 2 段構えにする。同梱物はページではないので
        連番の振り直しへ巻き込まない、という順序をここで表す。
        """
        if not self.archive_handler.create_archive(image_dir, output_path):
            return f"Failed to create archive for volume {volume}"
        return self._carry_sidecar(image_dir, output_path)

    def _carry_sidecar(self, image_dir: Path, output_path: Path) -> str | None:
        """加工前の画像と紐づけの記録を、作り直した本へそのまま持ち越す（#96）。

        サムネイル作成（#66）とページ分割（#58）は、加工前の画像と
        「加工後 -> 元」の記録を `.manga-organizer/` 配下へ同梱する。整理は本を
        作り直す操作だが、この配下はページではないので本文の収集は拾わない。
        持ち越さないと黙って落ちる。落ちた本は二度と戻せない。加工後の画素は
        既に捨てられていて、元を作り直す手立てが無いためで、切り抜きを広げる
        ことも、割った対を見開きへ畳み直すこともできなくなる。出来上がった本は
        正しく開けてページも揃うので、利用者は失ったことにその場では気づけない。

        エントリ名は変えずに書く。名前は中身のハッシュで決まっていて manifest
        の originals がその名前を指しているので、改名は取り落としと同じ。
        本文を書き終えた後に足すことで、ページの連番へ巻き込まれないようにする。

        持ち越すのは、その巻のフォルダの中にある物だけ。展開ルート直下に置かれた
        同梱物は、1 つの入力から複数巻が出るときどの巻の物か決められず、全巻へ
        配ると参照していない本まで他人の元画像を抱える。加工の経路はどちらも
        巻のフォルダの中へ書くので、この範囲で取りこぼさない。
        """
        members = sidecar_members(image_dir)
        if not members:
            # 加工していない本の出力は、いままでと 1 バイトも変えない。
            # 空の `.manga-organizer/` を作ると、加工と無縁の本まで中身が変わる
            return None

        try:
            with zipfile.ZipFile(output_path, "a", zipfile.ZIP_DEFLATED) as archive:
                for name, path in members:
                    archive.write(path, name)
        except (OSError, ValueError, zipfile.BadZipFile) as e:
            # 書けなかったことを黙って飲み込むと、元画像を失った本が成功として
            # 並び、元のアーカイブまで消される。失敗として返して元を残す
            self._log(f"Failed to keep pre-edit images: {e}", "error")
            return f"加工前の画像を持ち越せませんでした: {e}"

        self._log(f"    Kept {len(members)} pre-edit entries")
        return None

    def _location_key(self, image_dir: Path) -> str | None:
        """本の位置を表す鍵。展開ルートからの相対パスで、ルート自身は空文字。

        外す指定（``skip_locations``）と巻数の訂正（``volumes``）は、この 1 つの
        鍵空間を共有する。作り方を 2 か所に書いて片方だけずれると、同じ依頼の
        中で外す判定は効いているのに訂正だけが黙って落ちる。利用者から見えるのは
        「外したい本は外れたのに、直した巻数だけ元のまま」で、訂正が届かなかった
        のか値が無視されたのかを切り分ける手がかりが無い。

        鍵を決められないときは ``None``。名前や並び順で代用しないのは、1 つの
        アーカイブから同じ名前の本が 2 冊出たときに選り分けられないため。
        """
        root = self.archive_handler.extract_root
        if root is None:
            return None
        try:
            relative = image_dir.relative_to(root).as_posix()
        except ValueError:
            # 展開ルートの外は、そもそも予告できていない
            return None
        return relative if relative != "." else ""

    def _skipped(self, image_dir: Path, skip_locations: frozenset[str]) -> bool:
        """利用者が一覧で外した本かどうかを見る（#70 第 3 段階）。"""
        if not skip_locations:
            return False
        key = self._location_key(image_dir)
        if key is None:
            # 位置を名指しできない本は、予告もできていない。作る側に倒す
            return False
        return key in skip_locations

    def _corrected_volume(
        self,
        key: str | None,
        detected: int | None,
        volumes: Mapping[str, int | None],
    ) -> int | None:
        """利用者が訂正した巻数。訂正が無ければ自動判定のまま（#114 段階 B）。

        分けるのは鍵の**有無**であって値の有無ではない。``None`` は「巻数を
        付けないでほしい」という正当な訂正の値で、「まだ訂正していない」とは
        別物。両者を混ぜると、巻数を外す依頼が自動判定の番号へ静かに戻る。

        ``Mapping`` の既定値は鍵が無いときにしか使われないので、
        ``volumes.get(key, detected)`` は「鍵があればその値、無ければ自動判定」
        と同じ意味になる。既定は自動判定であって ``None`` ではない。
        """
        if key is None:
            return detected
        return volumes.get(key, detected)

    def _handle_original_deletion(
        self, archive_path: Path, results: list[ProcessResult], skipped: bool
    ):
        """Delete original archive if requested and all volumes were successful.

        外した本があるときは消さない。元を消すと、外した本を後から作り直す
        手立てが無くなる。同じ場所で作り直したときも消さない。元の場所に
        あるのは、もう出来上がった本そのもの（#127）。
        """
        rebuilt = any(r.output_path == archive_path for r in results)
        if (
            not skipped
            and not rebuilt
            and not self.keep_originals
            and all(r.success for r in results)
        ):
            try:
                archive_path.unlink()
                self._log(f"Deleted original: {archive_path}")
            except Exception as e:
                self._log(f"Failed to delete original: {e}", "error")

    def _process_image_directory(
        self,
        image_dir: Path,
        series: SeriesName,
        # 既定値は付けない。ここは「利用者が直したのに直らない」が黙って
        # 起きる経路で、渡し忘れても何も起きない形にしておくと、次に
        # 呼び出しを足す人が訂正を落としたことに誰も気づけない。
        # 公開側（``process_single_archive``）の既定値は残してある
        volumes: Mapping[str, int | None],
        suffix: int | None,
    ) -> list[ProcessResult]:
        """裸の画像フォルダを 1 冊として整える。

        ZIP に入っていない、画像が直接置かれたフォルダも 1 巻として扱う（#70）。
        展開が要らないので一時領域は作らず、元のフォルダをそのまま読む。
        巻数はフォルダ名から取る。アーカイブと違い元を消さないのは、
        フォルダごと消すのが取り返しのつかない操作だから。

        巻数の訂正を差し込む点が通常経路と 2 つに分かれるのは、この関数が
        展開もループも通らない別経路だから（#114 段階 B）。外すかどうかは
        呼び出し側が決める取り決めなので ``skip_locations`` は見ないが、
        フォルダ 1 つでも巻数は間違いうるので訂正は届く必要がある。
        フォルダは丸ごと 1 冊なので鍵は常に空文字。
        """
        self._log(f"Processing: {image_dir}")
        try:
            manga_dir = self._create_manga_directory(series)
            volume = self._corrected_volume(
                IMAGE_DIRECTORY_KEY,
                self.volume_detector.detect_volume(image_dir),
                volumes,
            )
            result = self._process_volume(
                image_dir, image_dir, manga_dir, volume, series, True, suffix
            )
            # 書き出す先は ZIP なので、フォルダ自身と同じになることはない
            return [result] if result is not None else []
        except Exception as e:
            self._log(f"Error processing {image_dir}: {e}", "error")
            return [
                ProcessResult(
                    original_path=image_dir,
                    output_path=None,
                    success=False,
                    error_message=str(e),
                )
            ]

    def process_single_archive(
        self,
        archive_path: Path,
        skip_locations: frozenset[str] = frozenset(),
        series: SeriesName | None = None,
        volumes: Mapping[str, int | None] = NO_VOLUME_OVERRIDES,
        on_book: BookDone | None = None,
        suffixes: Mapping[str, int] = NO_SUFFIXES,
    ) -> list[ProcessResult]:
        """Process a single archive file.

        ``skip_locations`` は、利用者が実行前の一覧で外した本の位置（展開
        ルートからの相対パス）。省くと従来どおり中身を全部作る。

        ``series`` はこの本を置く場所と名前を決める対（#73 段階 4a）。整理済みの
        本は自分自身の名前を持っているので、1 回の実行の中に依頼の対とは別の対が
        混ざる。省くと、いままでどおり ``set_manga_info`` で受けた依頼の対を使う。

        ``volumes`` は「位置 -> 訂正後の巻数」の地図（#114 段階 B）。自動判定を
        間違えた本を利用者が直せるようにする。鍵は ``skip_locations`` と同じ
        鍵空間（``_location_key``）で、値の ``None`` は「巻数を付けない」。
        省くと全冊が自動判定のまま、つまり今までどおりになる。

        ``on_book`` は 1 冊を書き終えるたびに呼ぶ（#160）。アーカイブ全体が
        済むのを待たずに、出来た本を知らせるため。

        ``suffixes`` は「位置 -> 名前に足す番号」（#166）。鍵は ``volumes`` と同じ。
        省くと今までどおり、出力先で空いている名前を前から使う。
        """
        series = series or SeriesName(self.author, self.title)

        # フォルダが来たら、その中身が 1 冊分。展開する物が無いので別経路へ回す
        # フォルダは丸ごと 1 冊なので、外すかどうかは呼び出し側が決めている。
        # 巻数の訂正はそうはいかないので、あちらの経路にも渡す
        if archive_path.is_dir():
            results = self._process_image_directory(
                archive_path, series, volumes, suffixes.get(IMAGE_DIRECTORY_KEY)
            )
            if on_book is not None:
                for result in results:
                    on_book(result, IMAGE_DIRECTORY_KEY)
            return results

        self._log(f"Processing: {archive_path}")
        results = []

        try:
            # Step 1: Validate and extract archive
            image_dirs, error = self._validate_and_extract_archive(archive_path)
            if error:
                return [
                    ProcessResult(
                        original_path=archive_path,
                        output_path=None,
                        success=False,
                        error_message=error,
                    )
                ]

            # Step 2: Create manga directory
            manga_dir = self._create_manga_directory(series)

            # Step 3: Process each volume
            if len(image_dirs) > 1:
                self._log(f"  Processing {len(image_dirs)} volumes...")

            skipped = False
            # 外した本も数え続ける。並び順（Priority 3）で巻数が決まる合本では
            # ``vol_idx`` がそのまま巻数になるので、``image_dirs`` を先に絞ると
            # 1 冊目を外した瞬間に 2 冊目が 1 巻になる。利用者は「作らない」と
            # 言っただけなのに、残した本の名前が変わる。
            #
            # 守るべきはこの ``enumerate`` の対象であって、ループの中で番号を
            # 決める位置ではない。中の 2 行（番号を決める / 外す判定）は
            # 入れ替えても何も変わらない（``vol_idx`` は既に決まっている）
            for vol_idx, image_dir in enumerate(image_dirs, 1):
                if len(image_dirs) > 1:
                    self._log(f"  Processing volume {vol_idx}/{len(image_dirs)}...")

                # Detect volume number
                volume = self._corrected_volume(
                    self._location_key(image_dir),
                    self._detect_volume_number(
                        image_dir, archive_path, vol_idx, len(image_dirs)
                    ),
                    volumes,
                )

                if self._skipped(image_dir, skip_locations):
                    skipped = True
                    self._log(f"  Skipped (excluded): volume {vol_idx}")
                    continue

                # Process the volume
                result = self._process_volume(
                    image_dir,
                    archive_path,
                    manga_dir,
                    volume,
                    series,
                    # 複数の本を抱えたアーカイブを 1 冊ぶんで置き換えると、
                    # 残りの本ごと元が消える。自分自身の上で作り直すのは
                    # 1 冊だけのときに限る
                    sole=len(image_dirs) == 1,
                    suffix=suffixes.get(self._location_key(image_dir) or ""),
                )
                if result is None:
                    # 行き先が元のアーカイブ自身で、作り直すまでもない。外した本と
                    # 同じ扱いにする。元を消さず、「1 冊も処理しなかった」失敗にもしない
                    skipped = True
                    self._log(f"  Skipped (already at destination): volume {vol_idx}")
                    continue
                results.append(result)
                if on_book is not None:
                    on_book(result, self._location_key(image_dir))

            # Step 4: Handle original deletion
            self._handle_original_deletion(archive_path, results, skipped)

            # 全部外したなら、作る物も失敗も無い。ここで「No volumes processed」を
            # 返すと、利用者が自分で外したものが失敗として並ぶ
            if skipped and not results:
                return []

            return (
                results
                if results
                else [
                    ProcessResult(
                        original_path=archive_path,
                        output_path=None,
                        success=False,
                        error_message="No volumes processed",
                    )
                ]
            )

        except Exception as e:
            self._log(f"Error processing {archive_path}: {e}", "error")
            return [
                ProcessResult(
                    original_path=archive_path,
                    output_path=None,
                    success=False,
                    error_message=str(e),
                )
            ]
        finally:
            # Cleanup temporary files
            self.archive_handler.cleanup()

    def process_archives(
        self, archives: list[Path], progress_callback=None
    ) -> list[ProcessResult]:
        """Process multiple archive files"""
        self.results = []

        for i, archive in enumerate(archives):
            if progress_callback:
                progress_callback(i + 1, len(archives), archive.name)

            # process_single_archive now returns a list of results
            results_for_archive = self.process_single_archive(archive)
            self.results.extend(results_for_archive)

        return self.results

    def get_summary(self) -> dict:
        """Get processing summary"""
        successful = sum(1 for r in self.results if r.success)
        failed = sum(1 for r in self.results if not r.success)

        return {
            "total": len(self.results),
            "successful": successful,
            "failed": failed,
            "results": self.results,
        }


def _damaged(path: Path) -> str | None:
    """書き上げた ZIP を読み直し、壊れていればその理由を返す。

    置き換えた後では元に戻せない。CRC まで突き合わせてから置き換える。
    """
    try:
        with zipfile.ZipFile(path) as archive:
            broken = archive.testzip()
    except (OSError, zipfile.BadZipFile) as error:
        return f"作り直した本を読み直せませんでした: {error}"
    if broken is not None:
        return f"作り直した本が壊れています: {broken}"
    return None
