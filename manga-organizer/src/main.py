#!/usr/bin/env python3
import sys
import logging
from pathlib import Path

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent))

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
        logger.info("Starting Manga Organizer")
        app = MainWindow()
        app.run()
    except Exception as e:
        logger.error(f"Application error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
