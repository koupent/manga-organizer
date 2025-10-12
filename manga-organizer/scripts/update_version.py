#!/usr/bin/env python3
"""
Version update script for Manga Organizer
Updates version numbers across all necessary files
"""

import sys
import re
from pathlib import Path
from datetime import datetime

def update_file(file_path, pattern, replacement, description):
    """Update version in a single file"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if pattern exists
        if not re.search(pattern, content):
            print(f"  ⚠️  Pattern not found in {file_path}")
            return False
        
        # Replace pattern
        new_content = re.sub(pattern, replacement, content)
        
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        
        print(f"  ✅ {description}: {file_path}")
        return True
    except Exception as e:
        print(f"  ❌ Error updating {file_path}: {e}")
        return False

def update_version(new_version):
    """Update version across all files"""
    
    # Get project root
    project_root = Path(__file__).parent.parent
    
    # Get current date
    current_date = datetime.now().strftime("%Y-%m-%d")
    
    print(f"\n🔄 Updating version to {new_version}")
    print(f"📅 Release date: {current_date}")
    print("-" * 50)
    
    # Files to update with their patterns
    updates = [
        {
            'file': project_root / 'pyproject.toml',
            'pattern': r'version = "[^"]*"',
            'replacement': f'version = "{new_version}"',
            'description': 'pyproject.toml'
        },
        {
            'file': project_root / 'src' / '__version__.py',
            'pattern': r'__version__ = "[^"]*"',
            'replacement': f'__version__ = "{new_version}"',
            'description': 'src/__version__.py (version)'
        },
        {
            'file': project_root / 'src' / '__version__.py',
            'pattern': r'__release_date__ = "[^"]*"',
            'replacement': f'__release_date__ = "{current_date}"',
            'description': 'src/__version__.py (date)'
        },
        {
            'file': project_root / 'version.py',
            'pattern': r'VERSION = "[^"]*"',
            'replacement': f'VERSION = "{new_version}"',
            'description': 'version.py (version)'
        },
        {
            'file': project_root / 'version.py',
            'pattern': r'RELEASE_DATE = "[^"]*"',
            'replacement': f'RELEASE_DATE = "{current_date}"',
            'description': 'version.py (date)'
        }
    ]
    
    success_count = 0
    for update in updates:
        if update_file(update['file'], update['pattern'], update['replacement'], update['description']):
            success_count += 1
    
    print("-" * 50)
    print(f"✨ Updated {success_count}/{len(updates)} files successfully")
    
    # Reminder about CHANGELOG
    print("\n📝 Don't forget to:")
    print("  1. Update CHANGELOG.md with release notes")
    print(f"  2. Commit changes with message: 'Release v{new_version}'")
    print(f"  3. Create a git tag: git tag v{new_version}")
    
    return success_count == len(updates)

def main():
    """Main entry point"""
    if len(sys.argv) != 2:
        print("Usage: python update_version.py <new_version>")
        print("Example: python update_version.py 3.6.6")
        sys.exit(1)
    
    new_version = sys.argv[1]
    
    # Validate version format
    if not re.match(r'^\d+\.\d+\.\d+$', new_version):
        print(f"Error: Invalid version format '{new_version}'")
        print("Expected format: X.Y.Z (e.g., 3.6.6)")
        sys.exit(1)
    
    # Update version
    success = update_version(new_version)
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()