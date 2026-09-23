# Release Guide - teegal-autoself-agent

Repo: https://github.com/shuobupodashi/teegal-autoself-agent
Default branch: main
Version single source of truth: package.json version field

## Publish a new version
1) npm version patch --no-git-tag-version   (or edit version manually)
2) git add -A ; git commit -m "chore(release): vX.Y.Z" ; git push origin main
3) git tag vX.Y.Z ; git push origin vX.Y.Z
4) GitHub Actions .github/workflows/release.yml runs automatically:
   - prepare: create GitHub Release + upload bootcode-vX.Y.Z.zip (source snapshot)
   - windows: Teegal-Setup-X.Y.Z.exe + latest.yml
   - macos: Teegal-X.Y.Z.dmg / .zip (x64 + arm64) + latest-mac.yml

## updateUrl for the agent
Set updateSourceUrl in userData/update-config.json to:
https://github.com/shuobupodashi/teegal-autoself-agent/releases/latest/download/
The trailing slash is REQUIRED: electron-updater generic provider resolves latest.yml relative to the base URL.

Manual trigger: Actions - Release - Run workflow (workflow_dispatch) with the tag name.
