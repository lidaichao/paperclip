$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-release.ps1')
$lock = Enter-PaperclipLauncherLock
try {
    $release = Resolve-PaperclipRelease
    $listener = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
    $serverProcessIds = @()
    foreach ($item in $listener) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($item.OwningProcess)"
        $null = Resolve-PaperclipServerProcess $process
        $serverProcessIds += $item.OwningProcess
    }
    if ($listener.Count -gt 0) { Assert-PaperclipIdle }
    $pgCtl = Join-Path $release.directory 'node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'
    $dbDir = Join-Path $script:PaperclipDataRoot 'instances/default/db'
    Assert-PaperclipUnlinkedPath $dbDir
    Assert-PaperclipUnlinkedPath $pgCtl
    $databaseProcess = $null
    if (Test-Path -LiteralPath "$dbDir/postmaster.pid") {
        $databasePid = [int](Get-Content -LiteralPath "$dbDir/postmaster.pid" -TotalCount 1)
        $databaseProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$databasePid" -ErrorAction SilentlyContinue
        if ($databaseProcess) {
            $arguments = @(Get-PaperclipProcessArguments $databaseProcess.CommandLine)
            $databaseMatches = $false
            for ($i = 0; $i -lt ($arguments.Count - 1); $i++) {
                if ($arguments[$i] -eq '-D' -and (Get-PaperclipFullPath $arguments[$i + 1]) -eq (Get-PaperclipFullPath $dbDir)) { $databaseMatches = $true }
            }
            if ($databaseProcess.Name -ne 'postgres.exe' -or -not $databaseMatches) { throw 'Database PID does not match this instance; refusing to signal it.' }
        }
    }
    if ($databaseProcess) {
        & $pgCtl stop -D $dbDir -m fast -w -t 15
        if ($LASTEXITCODE -ne 0) { throw 'Database shutdown failed; inspect the PostgreSQL log.' }
    }
    foreach ($serverProcessId in ($serverProcessIds | Select-Object -Unique)) {
        # Revalidate immediately before signaling in case a PID was recycled.
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId" -ErrorAction SilentlyContinue
        if ($process) { $null = Resolve-PaperclipServerProcess $process; Stop-Process -Id $serverProcessId -ErrorAction Stop }
    }
    Write-Output 'Paperclip stopped; database preserved.'
} finally { $lock.ReleaseMutex(); $lock.Dispose() }
