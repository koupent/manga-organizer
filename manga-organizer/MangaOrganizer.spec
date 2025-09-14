# -*- mode: python ; coding: utf-8 -*-

import os
import sys
from pathlib import Path

# Add src to path for version import
sys.path.insert(0, 'src')
from __version__ import __version__

block_cipher = None

# Check if 7-Zip files exist
seven_zip_exe = Path("resources/7zip/7z.exe")
seven_zip_dll = Path("resources/7zip/7z.dll")

binaries = []
if seven_zip_exe.exists() and seven_zip_dll.exists():
    # Include 7-Zip files in the bundle
    binaries = [
        (str(seven_zip_exe), "resources/7zip"),
        (str(seven_zip_dll), "resources/7zip"),
    ]
    print(f"✓ Found 7-Zip files to bundle")
else:
    print(f"⚠ 7-Zip files not found in resources/7zip/")
    print(f"  RAR support will depend on system-installed 7-Zip or UnRAR")

a = Analysis(
    ['src/main.py'],
    pathex=['src'],
    binaries=binaries,
    datas=[],
    hiddenimports=['rarfile'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=f'MangaOrganizer-v{__version__}',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)