param(
  [Parameter(Mandatory = $true)][string]$FixtureRoot,
  [Parameter(Mandatory = $true)][string]$ConfirmFixtureId
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($FixtureRoot)
if ($ConfirmFixtureId -ne 'PAP-17-G2') { throw 'Explicit fixture confirmation is required.' }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'fixture-manifest.json') | ConvertFrom-Json
$stopped = Get-Content -Raw -LiteralPath (Join-Path $root 'stop-confirmation.json') | ConvertFrom-Json
if ($manifest.fixtureId -ne 'PAP-17-G2' -or $stopped.confirmed -ne $true) {
  throw 'Refusing cleanup without the exact manifest and confirmed stop evidence.'
}
$leaf = Split-Path -Leaf $root
if ([IO.Path]::GetPathRoot($root) -eq $root -or $leaf -notmatch '^g2-formal-dispatch-fixture(?:-v\d+)?$') {
  throw "Refusing broad or unexpected cleanup target: $root"
}
Remove-Item -LiteralPath $root -Recurse -Force
Write-Output "Removed stopped PAP-17-G2 fixture: $root"
