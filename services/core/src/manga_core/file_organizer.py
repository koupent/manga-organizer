import logging
import zipfile
from dataclasses import dataclass
from pathlib import Path

from manga_core.archive_handler import ArchiveHandler
from manga_core.original_store import sidecar_members
from manga_core.volume_detector import VolumeDetector, format_series_dir

logger = logging.getLogger(__name__)


@dataclass
class ProcessResult:
    original_path: Path
    output_path: Path | None
    success: bool
    error_message: str | None = None
    volume_number: int | None = None


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

    def _create_manga_directory(self) -> Path:
        """Create output directory for manga series"""
        self._log("  Creating output directory for manga series...")
        manga_dir = self.output_directory / format_series_dir(self.author, self.title)
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
    ) -> ProcessResult:
        """Process a single volume and create output archive"""
        # Generate output filename
        output_name = self.volume_detector.format_volume_name(
            self.author, self.title, volume
        )

        # Get unique output path in the manga subdirectory
        output_path = self.volume_detector.get_unique_filename(manga_dir, output_name)

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

    def _skipped(self, image_dir: Path, skip_locations: frozenset[str]) -> bool:
        """利用者が一覧で外した本かどうかを見る（#70 第 3 段階）。

        突き合わせは展開ルートからの相対パスで行う。名前や並び順では、
        1 つのアーカイブから同じ名前の本が 2 冊出たときに選り分けられない。
        """
        if not skip_locations:
            return False
        root = self.archive_handler.extract_root
        if root is None:
            return False
        try:
            relative = image_dir.relative_to(root).as_posix()
        except ValueError:
            # 展開ルートの外は、そもそも予告できていない。作る側に倒す
            return False
        return (relative if relative != "." else "") in skip_locations

    def _handle_original_deletion(
        self, archive_path: Path, results: list[ProcessResult], skipped: bool
    ):
        """Delete original archive if requested and all volumes were successful.

        外した本があるときは消さない。元を消すと、外した本を後から作り直す
        手立てが無くなる。
        """
        if not skipped and not self.keep_originals and all(r.success for r in results):
            try:
                archive_path.unlink()
                self._log(f"Deleted original: {archive_path}")
            except Exception as e:
                self._log(f"Failed to delete original: {e}", "error")

    def _process_image_directory(self, image_dir: Path) -> list[ProcessResult]:
        """裸の画像フォルダを 1 冊として整える。

        ZIP に入っていない、画像が直接置かれたフォルダも 1 巻として扱う（#70）。
        展開が要らないので一時領域は作らず、元のフォルダをそのまま読む。
        巻数はフォルダ名から取る。アーカイブと違い元を消さないのは、
        フォルダごと消すのが取り返しのつかない操作だから。
        """
        self._log(f"Processing: {image_dir}")
        try:
            manga_dir = self._create_manga_directory()
            volume = self.volume_detector.detect_volume(image_dir)
            return [self._process_volume(image_dir, image_dir, manga_dir, volume)]
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
        self, archive_path: Path, skip_locations: frozenset[str] = frozenset()
    ) -> list[ProcessResult]:
        """Process a single archive file.

        ``skip_locations`` は、利用者が実行前の一覧で外した本の位置（展開
        ルートからの相対パス）。省くと従来どおり中身を全部作る。
        """
        # フォルダが来たら、その中身が 1 冊分。展開する物が無いので別経路へ回す
        # フォルダは丸ごと 1 冊なので、外すかどうかは呼び出し側が決めている
        if archive_path.is_dir():
            return self._process_image_directory(archive_path)

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
            manga_dir = self._create_manga_directory()

            # Step 3: Process each volume
            if len(image_dirs) > 1:
                self._log(f"  Processing {len(image_dirs)} volumes...")

            skipped = False
            for vol_idx, image_dir in enumerate(image_dirs, 1):
                if len(image_dirs) > 1:
                    self._log(f"  Processing volume {vol_idx}/{len(image_dirs)}...")

                # Detect volume number
                # 外した本のぶんも先に番号を決める。並び順（Priority 3）が
                # 巻数に効くので、飛ばしてから数えると残した本の巻数がずれる
                volume = self._detect_volume_number(
                    image_dir, archive_path, vol_idx, len(image_dirs)
                )

                if self._skipped(image_dir, skip_locations):
                    skipped = True
                    self._log(f"  Skipped (excluded): volume {vol_idx}")
                    continue

                # Process the volume
                result = self._process_volume(
                    image_dir, archive_path, manga_dir, volume
                )
                results.append(result)

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
