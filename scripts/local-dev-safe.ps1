$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$LiveHome = [IO.Path]::GetFullPath("H:\AIagent\Luna\.paperclip")
$DevHome = [IO.Path]::GetFullPath((Join-Path $RepoRoot ".paperclip-dev"))

if ($DevHome.Equals($LiveHome, [StringComparison]::OrdinalIgnoreCase) -or
    $DevHome.StartsWith($LiveHome + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to start: development data directory overlaps the live Paperclip home."
}

if ($env:DATABASE_URL) {
    throw "Refusing to start: DATABASE_URL is set. Clear it before using the isolated development launcher."
}

$env:PORT = "3101"
$env:PAPERCLIP_MIGRATION_PROMPT = "never"
$env:PAPERCLIP_MIGRATION_AUTO_APPLY = "true"

Write-Host "Development URL: http://127.0.0.1:3101"
Write-Host "Isolated data: $DevHome"
Write-Host "Protected live data: $LiveHome"

& corepack pnpm@9.15.4 dev --data-dir $DevHome
exit $LASTEXITCODE
