# -*- mode: python ; coding: utf-8 -*-

import os
import sys
from pathlib import Path

# Add src to path for version import
sys.path.insert(0, 'src')
from __version__ import __version__

block_cipher = None

# Check if 7za.exe (standalone) exists
seven_za_exe = Path("resources/7zip/7za.exe")

# Note: 7za.exe is now distributed separately to reduce false positives
# Users should download 7za.exe separately if RAR support is needed
binaries = []
if seven_za_exe.exists():
    # Option to include 7za.exe if present (but not recommended for false positive reduction)
    print("Warning: Including 7za.exe in bundle may increase false positive detections")
    print("  Consider distributing 7za.exe separately for better antivirus compatibility")
    # Uncomment the following lines if you still want to bundle 7za.exe
    # binaries = [
    #     (str(seven_za_exe), "resources/7zip"),
    # ]
    # print(f"  File size: {seven_za_exe.stat().st_size} bytes")
else:
    print("Info: 7za.exe not bundled (reduces false positives)")
    print("  RAR support will depend on system-installed 7-Zip or separate 7za.exe distribution")

a = Analysis(
    ['src/main.py'],
    pathex=['src'],
    binaries=binaries,
    datas=[
        # ページ修正 UI のテンプレート (utils.resources.resource_path が参照)
        ('src/web', 'web'),
    ],
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
    upx=False,  # Disabled UPX compression to reduce false positives
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
    # Consider adding version info file for better identification
    # version='version_info.txt',
)