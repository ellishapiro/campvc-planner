<#
  update_schedule.ps1 - one command to keep the planner's schedule current.

  What it does:
    1. Asks the campvc-schedule project to re-fetch the LIVE Camp VC schedule and
       compare it to the last snapshot (node build.js --check).
    2. If anything changed (or -Force), regenerates the workbook
       (node build.js + build_xlsx.ps1).
    3. Rebuilds the planner's data (python build_schedule.py), which prints a
       categorised change report: NEW events, REMOVED events, TIMING changes,
       and PAID/FREE flips.

  Usage (from the campvc-planner folder):
    powershell -ExecutionPolicy Bypass -File update_schedule.ps1
    powershell -ExecutionPolicy Bypass -File update_schedule.ps1 -CheckOnly
    powershell -ExecutionPolicy Bypass -File update_schedule.ps1 -Force
#>
param(
  [switch]$CheckOnly,   # report whether anything changed; regenerate nothing
  [switch]$Force        # regenerate even if the live check reports no change
)

$ErrorActionPreference = 'Stop'
$planner   = $PSScriptRoot
$gitRoot   = Split-Path $planner -Parent
$schedProj = Join-Path $gitRoot 'campvc-schedule'
$xlsx      = Join-Path $gitRoot 'CampVC_2026_Full_Schedule.xlsx'
$xlsxNew   = Join-Path $gitRoot 'CampVC_2026_Full_Schedule (new).xlsx'

function Section($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }

if (-not (Test-Path $schedProj)) { throw "Can't find campvc-schedule at $schedProj" }

# ---- 1. Check the live schedule ----------------------------------------------
Section 'Checking the live Camp VC schedule for changes'
Push-Location $schedProj
try { node build.js --check } finally { Pop-Location }
$checkCode = $LASTEXITCODE   # 0 = no change, 1 = changed, 2 = no snapshot yet
$liveChanged = ($checkCode -ne 0)

if ($CheckOnly) {
  Section 'Check only - comparing against the planner''s current data too'
  Push-Location $planner
  try { python build_schedule.py "$schedProj" --check } finally { Pop-Location }
  if ($liveChanged) {
    Write-Host "`nLive schedule HAS changed since the last snapshot. Re-run without -CheckOnly to update." -ForegroundColor Yellow
  } else {
    Write-Host "`nLive schedule unchanged." -ForegroundColor Green
  }
  exit 0
}

if (-not $liveChanged -and -not $Force) {
  Write-Host "`nNo upstream changes - nothing to regenerate. (Use -Force to rebuild anyway.)" -ForegroundColor Green
  exit 0
}

# ---- 2. Regenerate the workbook ----------------------------------------------
Section 'Regenerating the workbook from live data'
$before = if (Test-Path $xlsx) { (Get-Item $xlsx).LastWriteTime } else { [datetime]::MinValue }
if (Test-Path $xlsxNew) { Remove-Item $xlsxNew -Force }

Push-Location $schedProj
try {
  node build.js
  powershell -ExecutionPolicy Bypass -File build_xlsx.ps1
} finally { Pop-Location }

# build_xlsx.ps1 writes a "(new).xlsx" copy instead of failing if Excel has the
# workbook open. Detect that and stop, rather than rebuilding from stale data.
if (Test-Path $xlsxNew) {
  Write-Host "`nThe workbook is open in Excel, so new data was saved to:" -ForegroundColor Yellow
  Write-Host "  $xlsxNew" -ForegroundColor Yellow
  Write-Host "Close Excel, replace the original with that file, then re-run this script." -ForegroundColor Yellow
  exit 2
}
$after = (Get-Item $xlsx).LastWriteTime
if ($after -le $before -and -not $Force) {
  Write-Host "`nWorkbook wasn't updated (no write detected). Aborting before rebuild." -ForegroundColor Yellow
  exit 2
}

# ---- 3. Rebuild planner data + flag changes ----------------------------------
Section 'Rebuilding planner data and flagging changes'
Push-Location $planner
try { python build_schedule.py "$schedProj" } finally { Pop-Location }

Write-Host "`nDone. Review the change report above (also saved to data\CHANGES.md)." -ForegroundColor Green
Write-Host "If you've deployed to GitHub Pages, commit & push so everyone gets the update." -ForegroundColor Green
