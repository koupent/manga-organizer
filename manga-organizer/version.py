#!/usr/bin/env python3
"""Version information for Manga Organizer"""

VERSION = "3.6.4"
RELEASE_DATE = "2025-08-30"

if __name__ == "__main__":
    print(f"Manga Organizer v{VERSION}")
    print(f"Released: {RELEASE_DATE}")
    print("\nFeatures:")
    print("- Multi-format archive support (ZIP, RAR, 7z, CBZ, CBR, EPUB)")
    print("- Volume number auto-detection with improved accuracy")
    print("- Sequential image renaming (001.jpg, 002.jpg, etc.)")
    print("- Database management with JSON export/import")
    print("- API integration (AniList, MyAnimeList)")
    print("- Japanese UI with natural sorting")
    print("- Modal database editor")
    print("- Real-time processing logs")
    print("- Console window suppression for subprocess calls")