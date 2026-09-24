# Shared, read-only validation. Dot-source this file from the launchers.
$script:PaperclipOfficialRoot = 'H:/AIagent/Luna/tools/paperclip'
$script:PaperclipReleasesRoot = 'H:/AIagent/Luna/tools/paperclip-releases'
$script:PaperclipDataRoot = 'H:/AIagent/Luna/.paperclip'
$script:PaperclipBackendVersion = '2026.831.1'
$script:PaperclipNodePath = 'C:/Program Files/nodejs/node.exe'
$script:PaperclipEntryRelative = 'node_modules/paperclipai/dist/index.js'

function Get-PaperclipFullPath {
    param([Parameter(Mandatory)][string]$Path)
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Assert-PaperclipUnlinkedPath {
    param([Parameter(Mandatory)][string]$Path)
    $part = Get-PaperclipFullPath $Path
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Release paths cannot traverse symbolic links or junctions: $part"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if (-not $parent -or $parent -eq $part) { break }
        $part = $parent
    }
}

function Read-PaperclipReleaseJson {
    param([Parameter(Mandatory)][string]$Path)
    Assert-PaperclipUnlinkedPath $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required release file is missing: $Path" }
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-PaperclipFileHash {
    param([Parameter(Mandatory)][string]$Path)
    Assert-PaperclipUnlinkedPath $Path
    # Use .NET directly. Some background Windows PowerShell sessions start
    # without the Microsoft.PowerShell.Utility module that provides Get-FileHash.
    $stream = [IO.File]::OpenRead((Get-PaperclipFullPath $Path))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Resolve-PaperclipRelease {
    param([string]$Release)
    $pointer = $null
    $pointerPath = Join-Path $script:PaperclipDataRoot 'active-release.json'
    if (-not $Release) {
        if (Test-Path -LiteralPath $pointerPath) {
            $pointer = Read-PaperclipReleaseJson $pointerPath
            if ($pointer.schemaVersion -ne 1 -or -not $pointer.releaseId -or -not $pointer.directory) {
                throw 'Invalid active-release.json; refusing to silently fall back.'
            }
            $Release = [string]$pointer.directory
        } else { $Release = 'official' }
    }
    $official = Get-PaperclipFullPath $script:PaperclipOfficialRoot
    $releases = Get-PaperclipFullPath $script:PaperclipReleasesRoot
    if ($Release -match '(^|[\\/])\.\.?([\\/]|$)') { throw 'Release path traversal is not permitted.' }
    if ($Release -eq 'official') { $directory = $official }
    elseif ($Release -match '^\d{4}\.\d+\.\d+-zh\.\d+$') { $directory = Get-PaperclipFullPath (Join-Path $releases $Release) }
    elseif ([IO.Path]::IsPathRooted($Release)) { $directory = Get-PaperclipFullPath $Release }
    else { throw "Invalid release identifier: $Release" }
    $isOfficial = $directory -eq $official
    if (-not $isOfficial) {
        if ([IO.Path]::GetDirectoryName($directory) -ne $releases -or [IO.Path]::GetFileName($directory) -notmatch '^\d{4}\.\d+\.\d+-zh\.\d+$') {
            throw "Release is outside the permitted release root: $directory"
        }
    }
    Assert-PaperclipUnlinkedPath $directory
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw "Release directory does not exist: $directory" }
    $entrypoint = Join-Path $directory $script:PaperclipEntryRelative
    Assert-PaperclipUnlinkedPath $entrypoint
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "Release entrypoint is missing: $entrypoint" }
    $cliPackage = Read-PaperclipReleaseJson (Join-Path $directory 'node_modules/paperclipai/package.json')
    $backendPackage = Read-PaperclipReleaseJson (Join-Path $directory 'node_modules/@paperclipai/server/package.json')
    if ($cliPackage.version -ne $script:PaperclipBackendVersion -or $backendPackage.version -ne $script:PaperclipBackendVersion) {
        throw 'Cross-backend-version selection is refused. A separately verified database backup and upgrade procedure are required.'
    }
    $manifestHash = $null
    $releaseId = 'official'
    if (-not $isOfficial) {
        if (Test-Path -LiteralPath (Join-Path $directory 'BUILD-INCOMPLETE.json')) { throw 'Release build is incomplete.' }
        $manifestPath = Join-Path $directory 'release-manifest.json'
        $manifest = Read-PaperclipReleaseJson $manifestPath
        $releaseId = [IO.Path]::GetFileName($directory)
        if ($manifest.schemaVersion -ne 1 -or $manifest.releaseId -ne $releaseId -or $manifest.status -notin @('candidate', 'validated')) {
            throw 'Unsupported or mismatched release manifest.'
        }
        if ($manifest.backendVersion -ne $script:PaperclipBackendVersion -or $manifest.upstreamVersion -ne $script:PaperclipBackendVersion) {
            throw 'Cross-backend-version release is refused; perform a separate backed-up database upgrade.'
        }
        if ($manifest.entrypoint -ne $script:PaperclipEntryRelative) { throw 'Unexpected release entrypoint.' }
        $reportPath = Join-Path $directory 'validation-report.json'
        $report = Read-PaperclipReleaseJson $reportPath
        if ($report.passed -ne $true -or (Get-PaperclipFileHash $reportPath) -ne $manifest.testReportSha256) {
            throw 'Release validation evidence is missing, failed or changed.'
        }
        if ((Get-PaperclipFileHash (Join-Path $directory 'package-lock.json')) -ne $manifest.lockfileSha256) { throw 'Release lockfile changed.' }
        if ((Get-PaperclipFileHash (Join-Path $directory 'ui-assets.json')) -ne $manifest.uiAssetManifestSha256) { throw 'UI inventory changed.' }
        $backendInventory = Read-PaperclipReleaseJson (Join-Path $directory 'backend-files.json')
        $uiInventory = Read-PaperclipReleaseJson (Join-Path $directory 'ui-assets.json')
        if ($backendInventory.sha256 -ne $manifest.backendHash -or $uiInventory.sha256 -ne $manifest.uiTreeSha256) { throw 'Release inventory does not match the manifest.' }
        $uiIndex = Join-Path $directory 'node_modules/@paperclipai/server/ui-dist/index.html'
        Assert-PaperclipUnlinkedPath $uiIndex
        if (-not (Test-Path -LiteralPath $uiIndex -PathType Leaf)) { throw 'Localized UI index is missing.' }
        $manifestHash = Get-PaperclipFileHash $manifestPath
    }
    if ($pointer) {
        if ($pointer.releaseId -ne $releaseId -or $pointer.backendVersion -ne $script:PaperclipBackendVersion) { throw 'Active release pointer does not match the resolved release.' }
        if (-not $isOfficial -and $pointer.manifestSha256 -ne $manifestHash) { throw 'Selected release manifest changed after activation.' }
    }
    return [pscustomobject]@{ releaseId = $releaseId; directory = $directory; entrypoint = $entrypoint; backendVersion = $script:PaperclipBackendVersion; manifestSha256 = $manifestHash }
}

function Get-PaperclipProcessArguments {
    param([Parameter(Mandatory)][string]$CommandLine)
    return @([regex]::Matches($CommandLine, '"[^"\r\n]*"|\S+') | ForEach-Object { $_.Value.Trim('"') })
}

function Resolve-PaperclipServerProcess {
    param([Parameter(Mandatory)]$Process)
    if (-not $Process.ExecutablePath -or (Get-PaperclipFullPath $Process.ExecutablePath) -ne (Get-PaperclipFullPath $script:PaperclipNodePath)) {
        throw 'Listener executable is not the expected Node.js runtime; refusing to signal it.'
    }
    $entries = @(Get-PaperclipProcessArguments $Process.CommandLine | Where-Object { $_.Replace('\', '/') -match '/node_modules/paperclipai/dist/index\.js$' })
    if ($entries.Count -ne 1) { throw 'Listener is not an unambiguous Paperclip CLI process.' }
    $entry = $entries[0].Replace('\', '/')
    $suffix = '/' + $script:PaperclipEntryRelative
    $release = Resolve-PaperclipRelease -Release $entry.Substring(0, $entry.Length - $suffix.Length)
    if ((Get-PaperclipFullPath $entries[0]) -ne (Get-PaperclipFullPath $release.entrypoint)) { throw 'Listener entrypoint mismatch.' }
    return $release
}

function Assert-PaperclipIdle {
    # The live-only endpoint cannot hide old active runs behind recent history.
    $companyResponse = Invoke-RestMethod 'http://127.0.0.1:3100/api/companies' -TimeoutSec 5
    $companies = @($companyResponse)
    foreach ($company in $companies) {
        if (-not $company.id) { throw 'Unexpected companies response; cannot verify idle state.' }
        $runResponse = Invoke-RestMethod "http://127.0.0.1:3100/api/companies/$($company.id)/live-runs?minCount=0&limit=1" -TimeoutSec 5
        $runs = @($runResponse)
        if (@($runs | Where-Object { -not $_.status }).Count -gt 0) { throw 'Unexpected live-runs response; cannot verify idle state.' }
        if (@($runs | Where-Object { $_.status -in @('running', 'queued') }).Count -gt 0) {
            throw "Members are working in company $($company.id). Wait before stopping or selecting a release."
        }
    }
}

function Enter-PaperclipLauncherLock {
    $mutex = New-Object Threading.Mutex($false, 'Local\Luna.Paperclip.Launcher')
    try { $entered = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $entered = $true }
    if (-not $entered) { $mutex.Dispose(); throw 'Another Paperclip start, stop or release selection is in progress.' }
    return $mutex
}
