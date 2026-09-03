# -*- mode: python ; coding: utf-8 -*-
"""サイドカーの PyInstaller 定義。

onedir で作る。onefile は起動のたびに展開するため遅く、ウイルス対策ソフトの
誤検知も出やすい（#4〜#7）。Tauri のインストーラが丸ごと配るので、単一
ファイルである必要がない。
"""

a = Analysis(
    ["src/manga_api/__main__.py"],
    pathex=["src"],
    binaries=[],
    datas=[],
    hiddenimports=[
        "manga_core",
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="manga-api",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # 誤検知を減らすため無効
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="manga-api",
)
