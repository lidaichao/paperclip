param(
    [Parameter(Mandatory)][string]$Release,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-release.ps1')
$lock = Enter-PaperclipLauncherLock
try {
    $current = Resolve-PaperclipRelease
    $pointerPath = Join-Path $script:PaperclipDataRoot 'active-release.json'
    if ($Release -eq 'previous') {
        $oldPointer = Read-PaperclipReleaseJson $pointerPath
        if (-not $oldPointer.previous.directory) { throw 'No previous release is recorded.' }
        $candidate = Resolve-PaperclipRelease -Release $oldPointer.previous.directory
        if ($candidate.releaseId -ne $oldPointer.previous.releaseId -or $candidate.backendVersion -ne $oldPointer.previous.backendVersion -or $candidate.manifestSha256 -ne $oldPointer.previous.manifestSha256) {
            throw 'Previous release no longer matches its recorded identity.'
        }
    } else { $candidate = Resolve-PaperclipRelease -Release $Release }
    $listeners = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $null = Resolve-PaperclipServerProcess $process
    }
    if ($listeners.Count -gt 0) { Assert-PaperclipIdle }
    if ($CheckOnly) { $candidate | ConvertTo-Json; return }
    if ($candidate.directory -eq $current.directory) { Write-Output "Already selected: $($candidate.releaseId)"; return }
    Assert-PaperclipUnlinkedPath $pointerPath
    $pointer = [ordered]@{
        schemaVersion = 1
        releaseId = $candidate.releaseId
        directory = $candidate.directory
        backendVersion = $candidate.backendVersion
        manifestSha256 = $candidate.manifestSha256
        selectedAt = (Get-Date).ToUniversalTime().ToString('o')
        previous = $current
    }
    $tempPath = Join-Path $script:PaperclipDataRoot ('.active-release-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($tempPath, ($pointer | ConvertTo-Json -Depth 6), $bytes)
    if (Test-Path -LiteralPath $pointerPath) {
        # Same-filesystem replace is atomic and preserves the previous full pointer.
        $backupPath = Join-Path $script:PaperclipDataRoot ('active-release-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json')
        [IO.File]::Replace($tempPath, $pointerPath, $backupPath)
    } else { [IO.File]::Move($tempPath, $pointerPath) }
    Write-Output "Selected $($candidate.releaseId). No service was started or stopped. Restart Paperclip to apply."
} finally { $lock.ReleaseMutex(); $lock.Dispose() }
