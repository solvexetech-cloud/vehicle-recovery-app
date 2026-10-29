# ==========================================================
# VEHICLE RECOVERY APP - DATABASE RESTORE
# Usage:
#   .\scripts\restore.ps1 -BackupFile data\backups\app-YYYYMMDD-HHMMSS.db
# Safety: creates a rollback backup of current DB before restore
# ==========================================================
param(
    [Parameter(Mandatory=$true)][string]$BackupFile,
    [string]$Root = (Join-Path $HOME "Documents\VehicleRecoveryApp"),
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$dbPath = Join-Path $Root "data\app.db"
$backupsDir = Join-Path $Root "data\backups"

if (-not (Test-Path $BackupFile)) { throw "Backup file not found: $BackupFile" }

# Verify backup is a valid SQLite DB with expected tables
$verifyScript = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const tables = db.prepare(\"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','bookings','countries')\").get().n;
db.close();
if (tables !== 3) process.exit(1);
"@
$verifyScript | Out-File -FilePath (Join-Path $backupsDir ".verify.tmp.js") -Encoding utf8
try {
    node (Join-Path $backupsDir ".verify.tmp.js") $BackupFile
    if ($LASTEXITCODE -ne 0) { throw "Backup file invalid (missing required tables)" }
} finally {
    Remove-Item (Join-Path $backupsDir ".verify.tmp.js") -ErrorAction SilentlyContinue
}

if ((Test-Path $dbPath) -and -not $Force) {
    Write-Host "Current DB exists: $dbPath" -ForegroundColor Yellow
    $resp = Read-Host "Overwrite? Will create a rollback backup first (y/N)"
    if ($resp -notmatch '^[yY]') { Write-Host "Aborted"; exit 0 }
}

# Rollback backup of current DB
if (Test-Path $dbPath) {
    $rb = Join-Path $backupsDir ("rollback-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".db")
    Copy-Item $dbPath $rb -Force
    Write-Host "Rollback backup: $rb" -ForegroundColor Cyan
}

# Stop any running server? Caller responsibility.
Copy-Item $BackupFile $dbPath -Force
Write-Host "Restored $BackupFile -> $dbPath" -ForegroundColor Green