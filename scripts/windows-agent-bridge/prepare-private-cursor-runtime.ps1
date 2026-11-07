param(
  [Parameter(Mandatory = $true)][string]$WorkerHome,
  [Parameter(Mandatory = $true)][string]$CursorInstallRoot
)
$ErrorActionPreference = 'Stop'
$worker = (Resolve-Path -LiteralPath $WorkerHome).Path
$install = (Resolve-Path -LiteralPath $CursorInstallRoot).Path
$versions = Join-Path $install 'versions'
if (-not (Test-Path -LiteralPath $versions -PathType Container)) { throw 'Official Cursor versions directory is missing.' }
$latest = Get-ChildItem -LiteralPath $versions -Directory |
  Where-Object { $_.Name -match '^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$' -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'index.js')) } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $latest) { throw 'Official Cursor CLI runtime is missing.' }
$node = Join-Path $latest.FullName 'node.exe'
$entry = Join-Path $latest.FullName 'index.js'
$target = Join-Path $worker 'cursor-cli-forwarder.exe'
$paths = Join-Path $worker 'cursor-cli-paths.txt'
$source = Join-Path $PSScriptRoot 'cursor-cli-forwarder.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Windows C# compiler is missing.' }
& $compiler /nologo /target:exe "/out:$target" $source
if ($LASTEXITCODE -ne 0) { throw 'Cursor forwarder compilation failed.' }
[System.IO.File]::WriteAllLines($paths, [string[]]@($node, $entry), (New-Object System.Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'Cursor forwarder build failed.' }
Write-Output "Prepared private Cursor launcher in $worker for $($latest.Name)"
