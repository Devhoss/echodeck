# build-android.ps1
#
# Run from the repo root:
#   .\build-android.ps1          # builds with no version label
#   .\build-android.ps1 v1.2.0   # names the APK echodeck-v1.2.0.apk

param(
    [string]$Version = "local"
)

$APK_NAME = "echodeck-$Version.apk"

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  EchoDeck Android Build  —  $Version" -ForegroundColor Cyan
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""

# Stop on any error
$ErrorActionPreference = "Stop"

# ── 1. Build web bundle ───────────────────────────────────────────────────────
Write-Host "▶ Building web bundle..." -ForegroundColor Yellow
Set-Location client
npm run build

# ── 2. Sync into Capacitor ────────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Syncing Capacitor..." -ForegroundColor Yellow
npx cap sync android

# ── 3. Build APK with Gradle ──────────────────────────────────────────────────
Write-Host ""
Write-Host "▶ Building APK..." -ForegroundColor Yellow
Set-Location android
.\gradlew.bat assembleRelease --no-daemon

# ── 4. Copy to repo root with versioned name ──────────────────────────────────
Set-Location ..\..
$RELEASE_APK = "client\android\app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path $RELEASE_APK)) {
    throw "No signed APK. Add the ECHODECK_KEYSTORE* entries to ~/.gradle/gradle.properties."
}
Copy-Item $RELEASE_APK $APK_NAME

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host "  ✓ Done!  →  $APK_NAME" -ForegroundColor Green
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
Write-Host ""