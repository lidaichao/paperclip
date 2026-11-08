param([Parameter(Mandatory = $true)][string]$FixtureRoot)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($FixtureRoot)
$manifestPath = Join-Path $root 'fixture-manifest.json'
$runtimePath = Join-Path $root 'service-runtime.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
if ($manifest.fixtureId -ne 'PAP-17-G2') { throw 'Refusing to stop an unrecognized fixture.' }

[ordered]@{ requestedAt = [DateTimeOffset]::UtcNow.ToString('o'); requestedByPid = $PID } |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'stop-request.json') -Encoding utf8

$deadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
while (Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue) {
  if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Fixture service did not stop within 90 seconds.' }
  Start-Sleep -Milliseconds 250
}

function Test-PortOpen([int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync([Net.IPAddress]::Loopback, $Port)
    if (-not $task.Wait(1000)) { return $false }
    return $client.Connected
  } catch { return $false } finally { $client.Dispose() }
}

$confirmation = [ordered]@{
  schemaVersion = 1
  fixtureId = 'PAP-17-G2'
  checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
  servicePid = [int]$runtime.pid
  serviceProcessAbsent = -not (Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue)
  servicePortClosed = -not (Test-PortOpen ([int]([Uri]$runtime.apiUrl).Port))
  databasePortClosed = -not (Test-PortOpen ([int]$manifest.database.port))
}
$confirmation['confirmed'] = $confirmation.serviceProcessAbsent -and
  $confirmation.servicePortClosed -and $confirmation.databasePortClosed
$output = Join-Path $root 'stop-confirmation.json'
$confirmation | ConvertTo-Json | Set-Content -LiteralPath $output -Encoding utf8
if (-not $confirmation.confirmed) { throw "Fixture stop confirmation failed; inspect $output" }
Get-Content -Raw -LiteralPath $output
