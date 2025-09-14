# GitHub Actions Workflows

## Build and Release Workflow

This workflow automatically builds Windows executables when a version tag is pushed.

### How to Use

1. **Update version**:
   - Edit `src/__version__.py` to update the version number
   - Update `pyproject.toml` to match
   - Update `CHANGELOG.md` with release notes

2. **Commit changes**:
   ```bash
   git add .
   git commit -m "Release version 3.6.6"
   ```

3. **Create and push tag**:
   ```bash
   git tag v3.6.6
   git push origin main
   git push origin v3.6.6
   ```

4. **Wait for build**:
   - Go to Actions tab on GitHub
   - Watch the build progress
   - The release will be created automatically

### Manual Trigger

The workflow can also be triggered manually from the Actions tab for testing purposes.

### Build Process

1. Sets up Windows environment with Python 3.11
2. Installs dependencies using `uv`
3. Downloads 7-Zip portable (optional, for RAR support)
4. Builds executable with PyInstaller
5. Creates GitHub release with the built exe

### Artifacts

- The built executable is uploaded as an artifact (kept for 30 days)
- The executable is also attached to the GitHub release

### Requirements

The workflow requires:
- PyInstaller configuration in `MangaOrganizer.spec`
- Version info in `src/__version__.py`
- Release notes in `CHANGELOG.md`