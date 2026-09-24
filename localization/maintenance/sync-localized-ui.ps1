param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-release.ps1')

function Get-TreeHash {
    param([Parameter(Mandatory)][string]$Root)
    $rootPath = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
    $lines = Get-ChildItem -LiteralPath $rootPath -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/')
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$relative`t$hash`n"
        }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join ''))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Write-JsonUtf8 {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$Value)
    $json = $Value | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

$lock = Enter-PaperclipLauncherLock
try {
    $repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
    $source = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'ui\dist')).Path
    $release = Resolve-PaperclipRelease
    $target = (Resolve-Path -LiteralPath (Join-Path $release.directory 'node_modules\@paperclipai\server\ui-dist')).Path
    $releaseRoot = (Resolve-Path -LiteralPath $release.directory).Path.TrimEnd('\')
    if (-not $target.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "UI target is outside the selected release: $target"
    }

    if (-not $SkipBuild) {
        Push-Location $repoRoot
        try {
            & pnpm --filter @paperclipai/ui build
            if ($LASTEXITCODE -ne 0) { throw 'Localized UI build failed.' }
        } finally { Pop-Location }
    }

    & robocopy $source $target /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "UI synchronization failed with robocopy exit code $LASTEXITCODE." }

    $uiHash = Get-TreeHash $target
    $uiInventoryPath = Join-Path $release.directory 'ui-assets.json'
    $uiInventory = [ordered]@{
        schemaVersion = 1
        source = $source
        fileCount = @(Get-ChildItem -LiteralPath $target -Recurse -File).Count
        sha256 = $uiHash
    }
    Write-JsonUtf8 $uiInventoryPath $uiInventory

    $manifestPath = Join-Path $release.directory 'release-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest.uiTreeSha256 = $uiHash
    $manifest.uiAssetManifestSha256 = (Get-FileHash -LiteralPath $uiInventoryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-JsonUtf8 $manifestPath $manifest

    $pointerPath = Join-Path $script:PaperclipDataRoot 'active-release.json'
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pointer.releaseId -ne $release.releaseId) { throw 'Active release changed during UI synchronization.' }
    $pointer.manifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $pointer.selectedAt = [DateTimeOffset]::UtcNow.ToString('o')
    Write-JsonUtf8 $pointerPath $pointer

    Write-Output "Localized UI synchronized to $($release.releaseId). Refresh http://127.0.0.1:3100 to verify."
} finally {
    $lock.ReleaseMutex()
    $lock.Dispose()
}
