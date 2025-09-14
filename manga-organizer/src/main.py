#!/usr/bin/env python3
import sys
import logging
from pathlib import Path
from datetime import datetime, timedelta

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent))

from __version__ import __version__, __release_date__
from gui.main_window import MainWindow


def cleanup_old_logs(log_dir: Path, days: int = 30):
    """Clean up log files older than specified days"""
    try:
        cutoff_date = datetime.now() - timedelta(days=days)

        for log_file in log_dir.glob("manga_organizer_*.log"):
            # Extract date from filename (manga_organizer_YYYYMMDD.log)
            filename = log_file.stem  # Remove .log extension
            date_str = filename.replace("manga_organizer_", "")

            try:
                file_date = datetime.strptime(date_str, "%Y%m%d")
                if file_date < cutoff_date:
                    log_file.unlink()
                    print(f"Deleted old log file: {log_file.name}")
            except ValueError:
                # Skip files that don't match the expected format
                continue
    except Exception as e:
        # Don't let log cleanup errors prevent the application from starting
        print(f"Warning: Could not clean up old logs: {e}")


def setup_logging():
    """Set up logging configuration with date-based log files in logs directory"""
    # Create logs directory if it doesn't exist
    log_dir = Path("logs")
    log_dir.mkdir(exist_ok=True)

    # Create date-based log filename
    log_filename = f"manga_organizer_{datetime.now().strftime('%Y%m%d')}.log"
    log_file = log_dir / log_filename

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file, encoding='utf-8'),
            logging.StreamHandler()
        ],
    )

    # Clean up old log files (older than 30 days)
    cleanup_old_logs(log_dir, days=30)

    # Log the startup info
    logger = logging.getLogger(__name__)
    logger.info(f"Log file: {log_file}")


def main():
    setup_logging()
    logger = logging.getLogger(__name__)

    try:
        logger.info(f"Starting Manga Organizer v{__version__} (Released: {__release_date__})")
        app = MainWindow()
        app.run()
    except Exception as e:
        logger.error(f"Application error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
