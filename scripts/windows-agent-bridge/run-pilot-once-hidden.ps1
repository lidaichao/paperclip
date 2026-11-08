param(
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$EvidenceDir,
  [Parameter(Mandatory = $true)][string]$Phase,
  [int]$TimeoutMinutes = 120
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Phase -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') {
  throw 'Phase must be a short lowercase evidence label'
}
if ($TimeoutMinutes -lt 1 -or $TimeoutMinutes -gt 240) {
  throw 'TimeoutMinutes must be between 1 and 240'
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$configPath = (Resolve-Path -LiteralPath $Config).Path
$settings = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$workerHome = [IO.Path]::GetFullPath([string]$settings.workerHome)
$stateFile = Join-Path $workerHome 'claim-state.json'
$lockFile = "$stateFile.lock"
$launcher = Join-Path $PSScriptRoot 'dist\launcher.bundle.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$resolvedEvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
$phaseDir = Join-Path $resolvedEvidenceDir $Phase
$stdout = Join-Path $phaseDir 'launcher.stdout.log'
$stderr = Join-Path $phaseDir 'launcher.stderr.log'
$evidenceFile = Join-Path $phaseDir 'process-evidence.json'
$supervisorBase = Join-Path $workerHome 'supervisor-runs'

if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "Bridge bundle is missing: $launcher"
}
if (Test-Path -LiteralPath $lockFile) {
  throw "Bridge lock exists; finish the current member run before phase '$Phase'"
}
if (Test-Path -LiteralPath $stateFile) {
  $beforeState = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
  if ($null -ne $beforeState.activeClaim) {
    throw "Active claim exists; finish run $($beforeState.activeClaim.runId) before phase '$Phase'"
  }
}

New-Item -ItemType Directory -Path $phaseDir -Force | Out-Null
$existingRunDirs = @{}
if (Test-Path -LiteralPath $supervisorBase) {
  Get-ChildItem -LiteralPath $supervisorBase -Directory | ForEach-Object {
    $existingRunDirs[$_.FullName.ToLowerInvariant()] = $true
  }
}

$gitCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve candidate commit' }
$gitStatus = @(& git -C $repoRoot status --porcelain=v1)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect candidate worktree' }
if ($gitStatus.Count -ne 0) { throw 'Candidate worktree must be clean before a live pilot' }

$startedAt = [DateTimeOffset]::UtcNow
$launcherProcess = Start-Process -FilePath $node `
  -ArgumentList @($launcher, $configPath, '--pilot-once') `
  -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $stdout -RedirectStandardError $stderr

$deadline = [DateTimeOffset]::UtcNow.AddMinutes($TimeoutMinutes)
$claimSnapshot = $null
$supervisorPid = $null
$supervisorStartedAt = $null
$runId = $null

while (-not $launcherProcess.HasExited) {
  if ([DateTimeOffset]::UtcNow -ge $deadline) {
    throw "One-shot bridge exceeded $TimeoutMinutes minutes; inspect exact process evidence before recovery"
  }
  if (Test-Path -LiteralPath $stateFile) {
    try {
      $state = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
      if ($null -ne $state.activeClaim) {
        $claimSnapshot = $state.activeClaim
        $runId = [string]$state.activeClaim.runId
      }
      if (@($state.reportedProcesses).Count -eq 1) {
        $supervisorPid = [int]$state.reportedProcesses[0].pid
        $supervisor = Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue
        if ($null -ne $supervisor) {
          $supervisorStartedAt = $supervisor.StartTime.ToUniversalTime().ToString('o')
        }
      }
    } catch {
      # Atomic state replacement can briefly race this read; the next bounded poll retries.
    }
  }
  Start-Sleep -Milliseconds 250
  $launcherProcess.Refresh()
}
$launcherProcess.WaitForExit()
$finishedAt = [DateTimeOffset]::UtcNow

$newRunDirs = @()
if (Test-Path -LiteralPath $supervisorBase) {
  $newRunDirs = @(Get-ChildItem -LiteralPath $supervisorBase -Directory | Where-Object {
    -not $existingRunDirs.ContainsKey($_.FullName.ToLowerInvariant())
  })
}
if ($newRunDirs.Count -ne 1) {
  throw "Expected exactly one new supervised run, found $($newRunDirs.Count)"
}
if ($runId -and $newRunDirs[0].Name -ne $runId) {
  throw 'Claim state and supervisor receipt run IDs differ'
}
$runId = $newRunDirs[0].Name
$readyFile = Get-ChildItem -LiteralPath $newRunDirs[0].FullName -Recurse -Filter "$runId.ready.json" -File
$stoppedFile = Get-ChildItem -LiteralPath $newRunDirs[0].FullName -Recurse -Filter "$runId.stopped.json" -File
if (@($readyFile).Count -ne 1 -or @($stoppedFile).Count -ne 1) {
  throw 'One-shot bridge did not produce one ready receipt and one stopped receipt'
}
$ready = Get-Content -Raw -LiteralPath $readyFile.FullName | ConvertFrom-Json
$stopped = Get-Content -Raw -LiteralPath $stoppedFile.FullName | ConvertFrom-Json

$afterState = Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
$stopConfirmed = $stopped.activeProcesses -eq 0 -and
  -not (Get-Process -Id ([int]$ready.modelPid) -ErrorAction SilentlyContinue) -and
  -not (Get-Process -Id ([int]$ready.bridgePid) -ErrorAction SilentlyContinue) -and
  ($null -eq $afterState.activeClaim) -and
  -not (Test-Path -LiteralPath $lockFile)

$member = @($settings.agents)[0]
$evidence = [ordered]@{
  schemaVersion = 1
  phase = $Phase
  candidateCommit = $gitCommit
  configPath = $configPath
  member = [ordered]@{
    agentId = [string]$member.remoteAgentId
    agentName = [string]$member.remoteAgentName
    cwd = [string]$member.localAdapterConfig.cwd
    adapterType = [string]$member.adapterType
  }
  claim = $claimSnapshot
  processes = [ordered]@{
    launcherPid = $launcherProcess.Id
    launcherStartedAt = $startedAt.ToString('o')
    launcherExitedAt = $finishedAt.ToString('o')
    launcherExitCode = $launcherProcess.ExitCode
    bridgePid = [int]$ready.bridgePid
    bridgeCreationFileTime = [string]$ready.bridgeCreationFileTime
    supervisorPid = $supervisorPid
    supervisorStartedAt = $supervisorStartedAt
    modelPid = [int]$ready.modelPid
    modelCreationFileTime = [string]$ready.modelCreationFileTime
    modelExitedAt = [string]$stopped.completedAtUtc
    modelExitCode = [int]$stopped.modelExitCode
  }
  stop = [ordered]@{
    cause = [string]$stopped.cause
    activeProcesses = [int]$stopped.activeProcesses
    stateClaimCleared = $null -eq $afterState.activeClaim
    lockReleased = -not (Test-Path -LiteralPath $lockFile)
    bridgeProcessAbsent = -not (Get-Process -Id ([int]$ready.bridgePid) -ErrorAction SilentlyContinue)
    modelProcessAbsent = -not (Get-Process -Id ([int]$ready.modelPid) -ErrorAction SilentlyContinue)
    confirmed = $stopConfirmed
  }
  receipts = [ordered]@{
    ready = $readyFile.FullName
    stopped = $stoppedFile.FullName
    stdout = $stdout
    stderr = $stderr
  }
}

$evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidenceFile -Encoding utf8
if ($launcherProcess.ExitCode -ne 0) { throw "One-shot bridge exited $($launcherProcess.ExitCode)" }
if (-not $stopConfirmed) { throw 'One-shot bridge stopped without complete process-stop confirmation' }
Write-Output $evidenceFile
