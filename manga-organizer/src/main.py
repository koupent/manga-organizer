#!/usr/bin/env python3
import sys
import logging
from pathlib import Path

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent))

from __version__ import __version__, __release_date__
from gui.main_window import MainWindow


def setup_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[logging.FileHandler("manga_organizer.log"), logging.StreamHandler()],
    )


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
