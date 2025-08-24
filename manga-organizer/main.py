#!/usr/bin/env python3
"""
Manga Organizer - Main entry point
Redirects to the actual main module in src/
"""
import sys
from pathlib import Path

# Add src directory to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

# Import and run the actual main
from src.main import main

if __name__ == "__main__":
    main()
