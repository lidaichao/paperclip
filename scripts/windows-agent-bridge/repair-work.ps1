param([Parameter(Mandatory = $true)][string]$EvidenceRoot)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceRoot)
$target = Join-Path $root 'repair-model-command.json'
[ordered]@{
  schemaVersion = 1
  phase = 'repair'
  executedByPid = $PID
  cwd = (Get-Location).Path
  executedAt = [DateTimeOffset]::UtcNow.ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $target -Encoding utf8
Get-Content -Raw -LiteralPath $target
