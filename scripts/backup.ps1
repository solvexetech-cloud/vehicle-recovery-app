# ==========================================================
# VEHICLE RECOVERY APP - DATABASE BACKUP
# Simple file copy (safe for WAL mode)
# ==========================================================
param(
    [string]$Root = (Join-Path $HOME "Documents\VehicleRecoveryApp"),
    [int]$KeepCount = 7
)

$ErrorActionPreference = "Stop"
$dbPath = Join-Path $Root "data\app.db"
$backupsDir = Join-Path $Root "data\backups"

if (-not (Test-Path $dbPath)) {
    Write-Host "No database at $dbPath - nothing to backup" -ForegroundColor Yellow
    exit 0
}

New-Item -ItemType Directory -Path $backupsDir -Force | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFile = Join-Path $backupsDir "app-$timestamp.db"

# WAL mode requires checkpoint before copy — use node with proper sequence
$checkpointScript = @"
const { DatabaseSync } = require('node:sqlite');
const src = process.argv[1];
try {
  const db = new DatabaseSync(src);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
} catch (e) {
  // If DB is missing or corrupt, we'll still try the copy
}
"@
$checkpointScript | Out-File -FilePath (Join-Path $backupsDir ".checkpoint.tmp.js") -Encoding utf8
try {
    node (Join-Path $backupsDir ".checkpoint.tmp.js") $dbPath 2>$null
} finally {
    Remove-Item (Join-Path $backupsDir ".checkpoint.tmp.js") -ErrorAction SilentlyContinue
}

# Simple copy of the main DB file
Copy-Item $dbPath $backupFile -Force

# Copy WAL + SHM files if they exist (SQLite consistency)
$walFile = "$dbPath-wal"
$shmFile = "$dbPath-shm"
if (Test-Path $walFile) { Copy-Item $walFile "$backupFile-wal" -Force }
if (Test-Path $shmFile) { Copy-Item $shmFile "$backupFile-shm" -Force }

if (-not (Test-Path $backupFile)) {
    Write-Host "Backup failed - file not created" -ForegroundColor Red
    exit 1
}

$size = (Get-Item $backupFile).Length
Write-Host "Backup created: $backupFile ($size bytes)" -ForegroundColor Green

# Verify backup is a valid SQLite DB
$verifyScript = @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const tables = db.prepare(\"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('users','countries')\").get().n;
db.close();
if (tables < 2) { console.error('Backup verification failed: missing tables'); process.exit(1); }
"@
$verifyScript | Out-File -FilePath (Join-Path $backupsDir ".verify.tmp.js") -Encoding utf8
try {
    node (Join-Path $backupsDir ".verify.tmp.js") $backupFile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Backup verification failed - removing corrupted backup" -ForegroundColor Red
        Remove-Item $backupFile -Force -ErrorAction SilentlyContinue
        exit 1
    }
} finally {
    Remove-Item (Join-Path $backupsDir ".verify.tmp.js") -ErrorAction SilentlyContinue
}

Write-Host "Backup verified OK" -ForegroundColor Green

# Retention
$all = Get-ChildItem -Path $backupsDir -Filter "app-*.db" | Sort-Object LastWriteTime -Descending
if ($all.Count -gt $KeepCount) {
    $toDelete = $all | Select-Object -Skip $KeepCount
    foreach ($f in $toDelete) {
        Remove-Item $f.FullName -Force
        Remove-Item ($f.FullName + "-wal") -Force -ErrorAction SilentlyContinue
        Remove-Item ($f.FullName + "-shm") -Force -ErrorAction SilentlyContinue
        Write-Host "  pruned: $($f.Name)" -ForegroundColor DarkGray
    }
}
Write-Host "Total backups kept: $([Math]::Min($all.Count, $KeepCount))" -ForegroundColor Green
