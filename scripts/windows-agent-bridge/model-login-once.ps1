param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [switch]$Login,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'
if ($Login -and $Probe) { throw 'Choose one action: -Login or -Probe.' }
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$config = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
if ($config.schemaVersion -ne 3 -or @($config.agents).Count -ne 1) {
  throw 'Expected a version 3 single-member bridge configuration.'
}
$agent = $config.agents[0]
if ($agent.adapterType -notin @('codex_local', 'cursor')) { throw 'Unsupported model adapter.' }
$configDir = Split-Path -Parent $resolvedConfig
$workerHome = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($configDir, [string]$config.workerHome))
$command = [string]$agent.localAdapterConfig.command
if (-not [System.IO.Path]::IsPathRooted($command) -or -not $command.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $command -PathType Leaf)) {
  throw 'The configured model CLI must be an existing absolute .exe path.'
}
$privateHome = Join-Path $workerHome 'home'
$authFile = if ($agent.adapterType -eq 'codex_local') {
  Join-Path $workerHome 'codex-home\auth.json'
} else {
  Join-Path $privateHome '.cursor\cli-config.json'
}
Write-Output ('Member: ' + [string]$agent.remoteAgentName)
Write-Output ('Adapter: ' + [string]$agent.adapterType)
Write-Output ('Private login file present: ' + [bool](Test-Path -LiteralPath $authFile -PathType Leaf))
if (-not $Login -and -not $Probe) { return }
foreach ($candidate in @($workerHome, (Split-Path -Parent $authFile), $authFile)) {
  if (Test-Path -LiteralPath $candidate) {
    $entry = Get-Item -LiteralPath $candidate -Force
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Private model login path must not use a link or junction.'
    }
  }
}

# Only an explicit -Login performs one interactive CLI login. -Probe makes one
# read-only model request. Neither mode creates another terminal or retries.
$original = @{}
foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
  $original[[string]$entry.Key] = [string]$entry.Value
}
$osKeys = @('PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PROGRAMDATA',
  'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN')
try {
  foreach ($name in @($original.Keys)) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  foreach ($name in $osKeys) {
    $matching = @($original.Keys | Where-Object { $_ -ieq $name })
    if ($matching.Count -gt 0) { [Environment]::SetEnvironmentVariable($name, $original[$matching[0]], 'Process') }
  }
  $privateDirs = @($privateHome, (Join-Path $workerHome 'codex-home'),
    (Join-Path $privateHome '.cursor'), (Join-Path $workerHome 'appdata'),
    (Join-Path $workerHome 'localappdata'), (Join-Path $workerHome 'temp'),
    (Join-Path $workerHome 'config'), (Join-Path $workerHome 'paperclip-home'))
  foreach ($folder in $privateDirs) { [void](New-Item -ItemType Directory -Path $folder -Force) }
  $privateEnv = @{
    HOME = $privateHome; USERPROFILE = $privateHome;
    CODEX_HOME = (Join-Path $workerHome 'codex-home');
    CURSOR_HOME = (Join-Path $privateHome '.cursor');
    PAPERCLIP_HOME = (Join-Path $workerHome 'paperclip-home');
    APPDATA = (Join-Path $workerHome 'appdata');
    LOCALAPPDATA = (Join-Path $workerHome 'localappdata');
    TEMP = (Join-Path $workerHome 'temp'); TMP = (Join-Path $workerHome 'temp');
    XDG_CONFIG_HOME = (Join-Path $workerHome 'config');
    NO_OPEN_BROWSER = '1'
  }
  foreach ($entry in $privateEnv.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
  }
  if ($Login) {
    if ($agent.adapterType -eq 'codex_local') { & $command login --device-auth }
    else { & $command login }
    if ($LASTEXITCODE -ne 0) { throw 'Private model login failed; no retry was attempted.' }
  }
  if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
    throw 'Private model login file is missing.'
  }
  if (((Get-Item -LiteralPath $authFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Private model login file must not be a link.'
  }
  if ($agent.adapterType -eq 'codex_local') { & $command login status | Out-Null }
  else { & $command status --format text | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw 'Private model login status check failed.' }
  if ($Login) {
    Write-Output 'Private model login completed; run -Probe once after this.'
  } else {
    $probeArgs = if ($agent.adapterType -eq 'codex_local') {
      @('exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'read-only', '-C', $privateHome, '--json', 'Reply OK only. Do not use tools or read files.')
    } else {
      @('-p', '--mode', 'ask', '--output-format', 'json', '--model', [string]$agent.localAdapterConfig.model,
        '--workspace', $privateHome, 'Reply OK only. Do not use tools or read files.')
    }
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $command
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $probeArgs) { [void]$start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    try {
      $output = $process.StandardOutput.ReadToEndAsync()
      $errorOutput = $process.StandardError.ReadToEndAsync()
      if (-not $process.WaitForExit(30000)) {
        $process.Kill($true)
        throw 'One-shot model probe timed out after 30 seconds.'
      }
      $output.GetAwaiter().GetResult() | Out-Null
      $errorOutput.GetAwaiter().GetResult() | Out-Null
      if ($process.ExitCode -ne 0) { throw 'One-shot model probe failed; inspect private CLI login without retrying automatically.' }
      Write-Output 'One-shot private model probe passed.'
    } finally { $process.Dispose() }
  }
} finally {
  foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
    [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process')
  }
  foreach ($entry in $original.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
  }
}
