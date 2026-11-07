param([string]$OutputPath = (Join-Path $PSScriptRoot 'out\PaperclipRunSupervisor.exe'))
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'Windows is required.' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '64-bit .NET Framework 4 csc.exe is required.' }
$source = Join-Path $PSScriptRoot 'Supervisor.cs'
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$resolvedOutput" $source
if ($LASTEXITCODE -ne 0) { throw "Supervisor compilation failed with exit code $LASTEXITCODE." }
Write-Output $resolvedOutput
