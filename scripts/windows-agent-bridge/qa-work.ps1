param([Parameter(Mandatory = $true)][string]$EvidenceRoot)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($EvidenceRoot)
$repair = Join-Path $root 'repair-model-command.json'
if (-not (Test-Path -LiteralPath $repair -PathType Leaf)) {
  throw 'Repair model command evidence is missing; QA must not pass.'
}
$target = Join-Path $root 'qa-model-command.json'
[ordered]@{
  schemaVersion = 1
  phase = 'qa'
  executedByPid = $PID
  cwd = (Get-Location).Path
  executedAt = [DateTimeOffset]::UtcNow.ToString('o')
  repairEvidence = $repair
} | ConvertTo-Json | Set-Content -LiteralPath $target -Encoding utf8
Get-Content -Raw -LiteralPath $target
