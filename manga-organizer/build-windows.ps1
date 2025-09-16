# Manga Organizer Build Script for Windows
# This script builds the executable with proper settings to prevent console windows

# Get version from src/__version__.py if available
$Version = "3.6.1"  # Default version

if (Test-Path "src\__version__.py") {
    try {
        $versionLine = Get-Content "src\__version__.py" | Select-String "__version__\s*=\s*[`"`']([^`"`']+)[`"`']"
        if ($versionLine) {
            $Version = $versionLine.Matches[0].Groups[1].Value
        }
    } catch {
        Write-Host "Warning: Could not read version from __version__.py, using default: $Version" -ForegroundColor Yellow
    }
} elseif (Test-Path "version.py") {
    # Fallback to old version.py
    try {
        $output = & python version.py 2>&1
        $versionLine = $output | Select-String "Manga Organizer v([\d.]+)"
        if ($versionLine) {
            $Version = $versionLine.Matches[0].Groups[1].Value
        }
    } catch {
        Write-Host "Warning: Could not read version from version.py, using default: $Version" -ForegroundColor Yellow
    }
}

$AppName = "MangaOrganizer"
$ExeName = "${AppName}-v${Version}"

Write-Host "=== Building ${AppName} v${Version} ===" -ForegroundColor Cyan
Write-Host ""

# Check if we're in the right directory
if (!(Test-Path "src\main.py")) {
    Write-Host "Error: src\main.py not found" -ForegroundColor Red
    Write-Host "Please run this script from the manga-organizer directory"
    exit 1
}

# Clean previous builds
Write-Host "Cleaning previous builds..." -ForegroundColor Yellow
if (Test-Path "dist") {
    Remove-Item -Recurse -Force "dist"
    Write-Host "  - Removed dist\" -ForegroundColor Gray
}
if (Test-Path "build") {
    Remove-Item -Recurse -Force "build"
    Write-Host "  - Removed build\" -ForegroundColor Gray
}
# Note: MangaOrganizer.spec is now version-controlled for consistent builds
# Do not delete it during cleanup
Write-Host "Cleanup complete" -ForegroundColor Green
Write-Host ""

# Check for PyInstaller
Write-Host "Checking PyInstaller..." -ForegroundColor Yellow
try {
    $pyinstallerVersion = & pyinstaller --version 2>&1
    Write-Host "PyInstaller: $pyinstallerVersion" -ForegroundColor Green
} catch {
    Write-Host "PyInstaller not found. Installing..." -ForegroundColor Yellow
    pip install pyinstaller
    Write-Host "PyInstaller installed" -ForegroundColor Green
}
Write-Host ""

# Build using spec file if available
if (Test-Path "MangaOrganizer.spec") {
    Write-Host "Building with optimized spec file..." -ForegroundColor Yellow
    Write-Host "  - UPX compression: Disabled (false positive reduction)" -ForegroundColor Cyan
    Write-Host "  - 7za.exe: Distributed separately (false positive reduction)" -ForegroundColor Cyan
    Write-Host "This prevents console windows from appearing" -ForegroundColor Cyan
    & pyinstaller MangaOrganizer.spec
} elseif (Test-Path "MangaOrganizer-Windows.spec") {
    Write-Host "Building with Windows spec file..." -ForegroundColor Yellow
    Write-Host "This prevents console windows from appearing" -ForegroundColor Cyan
    & pyinstaller MangaOrganizer-Windows.spec
} else {
    # Fallback to command line build
    Write-Host "Building with command line options..." -ForegroundColor Yellow
    Write-Host "Note: Using spec file is recommended for false positive reduction" -ForegroundColor Yellow
    # Note: PyInstaller v6.0+ removed --win-no-prefer-redirects and --win-private-assemblies
    $buildArgs = @(
        "--onefile",
        "--noconsole",
        "--windowed",
        "--name", $ExeName,
        "--paths", "src",
        "--hidden-import", "rarfile",
        "--exclude-module", "matplotlib",
        "--exclude-module", "numpy",
        "--exclude-module", "scipy",
        "--exclude-module", "pandas",
        "src\main.py"
    )
    
    & pyinstaller $buildArgs
}

# Check build result
$exePath = if (Test-Path "MangaOrganizer.spec") {
    "dist\${ExeName}.exe"
} elseif (Test-Path "MangaOrganizer-Windows.spec") {
    "dist\MangaOrganizer.exe"
} else {
    "dist\${ExeName}.exe"
}

if (Test-Path $exePath) {
    Write-Host ""
    Write-Host "=== Build Successful! ===" -ForegroundColor Green
    Write-Host "Executable: $exePath" -ForegroundColor Cyan
    
    $fileSize = (Get-Item $exePath).Length / 1MB
    Write-Host "File size: $([math]::Round($fileSize, 2)) MB" -ForegroundColor Cyan
    
    # Create release folder
    $releaseDir = "release\MangaOrganizer-v${Version}"
    if (!(Test-Path $releaseDir)) {
        New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    }
    
    # Copy files to release folder
    Copy-Item $exePath "$releaseDir\MangaOrganizer.exe" -Force
    if (Test-Path "README.md") {
        Copy-Item "README.md" $releaseDir -Force
    }
    if (Test-Path "CHANGELOG.md") {
        Copy-Item "CHANGELOG.md" $releaseDir -Force
    }
    
    # Create data directory
    New-Item -ItemType Directory -Force -Path "$releaseDir\data" | Out-Null
    
    Write-Host ""
    Write-Host "Release folder created: $releaseDir" -ForegroundColor Green
    Write-Host ""
    
    # Ask to run the application
    $response = Read-Host "Do you want to test the application? (y/n)"
    if ($response -eq 'y' -or $response -eq 'Y') {
        Write-Host "Starting application..." -ForegroundColor Yellow
        Start-Process $exePath
        Write-Host "Application started" -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "=== Build Failed ===" -ForegroundColor Red
    Write-Host "Please check the error messages above"
    exit 1
}

Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green