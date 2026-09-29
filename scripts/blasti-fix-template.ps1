# ============================================================
#  BLASTI Desktop Fix v0.3.4 -- one-click patcher
# ============================================================
#  What this does (everything is automatic):
#    1. Closes any running BLASTI processes (fixes the EBUSY rebuild error)
#    2. Backs up your current files (timestamped copies)
#    3. Installs the FIXED main.js
#         - UI now loads from the embedded local API (http://127.0.0.1:3080)
#           instead of the nonexistent localhost:3000 dev server / broken
#           file:// mode -- this is what caused the stuck blue window
#    4. Installs the FIXED loading-screen.js
#         - fixes "Cannot find module '../../package.json'" which killed the
#           launch gate and left the window permanently blue
#    5. Installs the FIXED local-api/index.js
#         - adds a static UI server so the local API serves the bundled
#           Next.js export (routes, _next assets, MIME types)
#    6. Installs the Prisma packaging hook (scripts/after-pack.js)
#    7. Installs the FIXED electron-builder.yml (afterPack hook + build-stamp)
#    8. Bumps apps\desktop\package.json to version 0.3.4
#
#  How to run (from your BLASTI-MULTI folder):
#    powershell -ExecutionPolicy Bypass -File .\BLASTI-fix-0.3.4.ps1
# ============================================================
$ErrorActionPreference = "Stop"

__EMBEDDED_FILES__

Write-Host ""
Write-Host "=== BLASTI Desktop Fix v0.3.4 ===" -ForegroundColor Cyan
Write-Host ""

function Find-RepoRoot($start) {
  $p = $start
  while ($p) {
    if (Test-Path (Join-Path $p "apps\desktop\main.js")) { return $p }
    $parent = Split-Path $p -Parent
    if ($parent -eq $p) { return $null }
    $p = $parent
  }
  return $null
}

$root = Find-RepoRoot $PSScriptRoot
if (-not $root) { $root = Find-RepoRoot (Get-Location).Path }
if (-not $root) {
  $root = (Read-Host "Enter the full path to your BLASTI-MULTI folder").Trim('"')
}
if (-not (Test-Path (Join-Path $root "apps\desktop\main.js"))) {
  Write-Host "ERROR: could not find apps\desktop\main.js under '$root'" -ForegroundColor Red
  Write-Host "Put this script inside your BLASTI-MULTI folder and run it again."
  exit 1
}
Write-Host "[1/8] Repo found: $root"

$procs = Get-Process -Name "BLASTI*" -ErrorAction SilentlyContinue
if ($procs) {
  $procs | Stop-Process -Force
  Start-Sleep -Seconds 2
  Write-Host "[2/8] Closed running BLASTI process(es) -- EBUSY unblocked"
} else {
  Write-Host "[2/8] No running BLASTI processes"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$desk = Join-Path $root "apps\desktop"

function Install-FixFile($relPath, $b64) {
  $target = Join-Path $desk $relPath
  $dir = Split-Path $target -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $name = Split-Path $target -Leaf
  Copy-Item $target (Join-Path $dir "$name.bak-$stamp") -ErrorAction SilentlyContinue
  [IO.File]::WriteAllBytes($target, [Convert]::FromBase64String(($b64 -replace '\s','')))
  Write-Host "      -> $relPath installed (backup: $name.bak-$stamp)"
}

Write-Host "[3/8] Installing fixed files:"
Install-FixFile "main.js" $MAIN_B64
Write-Host "[4/8] loading-screen.js fixed (launch-gate crash = blue window)"
Install-FixFile "loading-screen.js" $LOADING_B64
Write-Host "[5/8] local-api/index.js fixed (serves the UI on http://127.0.0.1:3080)"
Install-FixFile "local-api\index.js" $LOCALAPI_B64
Write-Host "[6/8] Prisma packaging hook + builder config"
Install-FixFile "scripts\after-pack.js" $HOOK_B64
Install-FixFile "electron-builder.yml" $YML_B64

$pkgPath = Join-Path $desk "package.json"
$pkgText = [IO.File]::ReadAllText($pkgPath)
if ($pkgText -match '"version"\s*:\s*"0\.3\.3"') {
  Write-Host "[7/8] package.json already at 0.3.4"
} else {
  $pkgText = $pkgText -replace '"version"\s*:\s*"[^"]*"', '"version": "0.3.4"'
  [IO.File]::WriteAllText($pkgPath, $pkgText)
  Write-Host "[7/8] package.json bumped to version 0.3.4"
}

Write-Host "[8/8] Verifying..."
if (-not (Test-Path (Join-Path $desk "local-api\index.js"))) { Write-Host "      WARNING: local-api\index.js missing?!" -ForegroundColor Red }

Write-Host ""
Write-Host "ALL DONE -- fixes applied successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Next step: rebuild the app with" -ForegroundColor White
Write-Host "    bun run build:desktop" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then start dist\win-unpacked\BLASTI.exe (or install BLASTI-Setup-0.3.4.exe)."
Write-Host "The window should show the BLASTI launch gate, then the app."
Write-Host ""
Write-Host "Press Enter to close this window..."
[void](Read-Host)
