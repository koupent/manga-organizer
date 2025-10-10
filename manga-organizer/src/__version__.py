"""Version information for Manga Organizer

This file is the single source of truth for version information.
It should be imported by all modules that need version info.
"""

__version__ = "3.8.1"
__release_date__ = "2025-10-10"
__author__ = "Manga Organizer Team"
__description__ = "Japanese manga archive organizer with intelligent volume detection"

# Feature flags
FEATURES = {
    "multi_format_support": True,
    "volume_detection": True,
    "image_renaming": True,
    "database_management": True,
    "api_integration": True,
    "console_suppression": True,
}


def get_version_string():
    """Return formatted version string for display"""
    return f"v{__version__}"


def get_full_version_info():
    """Return complete version information"""
    return {
        "version": __version__,
        "release_date": __release_date__,
        "author": __author__,
        "description": __description__,
        "features": FEATURES,
    }


if __name__ == "__main__":
    print(f"Manga Organizer {get_version_string()}")
    print(f"Released: {__release_date__}")
