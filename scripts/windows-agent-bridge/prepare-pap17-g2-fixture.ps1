param(
  [string]$FixtureRoot = 'H:\AIagent\Rabbit\.paperclip\evidence\PAP-17\g2-formal-dispatch-fixture',
  [int]$ServerPort = 32117,
  [int]$DatabasePort = 55117
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fixtureRootPath = [IO.Path]::GetFullPath($FixtureRoot)
$candidateCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve candidate commit.' }
$status = @(& git -C $repoRoot status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
  throw 'Candidate worktree must be clean before preparing the live fixture.'
}
& git -C $repoRoot merge-base --is-ancestor 8a45b24e8302d3f7bdc113eeb1f85c483e71ed8e HEAD
if ($LASTEXITCODE -ne 0) { throw 'Candidate does not descend from the fixed 8a45b24e baseline.' }
if (Test-Path -LiteralPath $fixtureRootPath) {
  throw "Fixture root already exists: $fixtureRootPath. Stop and clean it explicitly before rebuilding."
}

function Assert-PortFree([int]$Port) {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  try { $listener.Start() } catch { throw "Loopback port $Port is already in use." } finally { $listener.Stop() }
}

Assert-PortFree $ServerPort
Assert-PortFree $DatabasePort

$instanceId = 'pap17-g2-formal'
$instanceRoot = Join-Path $fixtureRootPath "paperclip-home\instances\$instanceId"
$configPath = Join-Path $instanceRoot 'config.json'
$logDir = Join-Path $fixtureRootPath 'logs'
$idsPath = Join-Path $fixtureRootPath 'fixture-ids.json'
$serverStdout = Join-Path $logDir 'service.stdout.log'
$serverStderr = Join-Path $logDir 'service.stderr.log'
$runtimePath = Join-Path $fixtureRootPath 'service-runtime.json'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
$tsx = Join-Path $repoRoot 'server\node_modules\tsx\dist\cli.mjs'
$serverHost = Join-Path $PSScriptRoot 'pap17-g2-fixture-server.ts'
$seeder = Join-Path $PSScriptRoot 'seed-pap17-g2-fixture.ts'
$dispatcher = Join-Path $PSScriptRoot 'prepare-pap17-g2-dispatch.ts'
$credentialHelper = Join-Path $PSScriptRoot 'credential-helper.ps1'
$supervisor = Join-Path $PSScriptRoot 'supervisor\out\PaperclipRunSupervisor.exe'
$rabbitGbrain = 'H:\AIagent\Rabbit\.paperclip\gbrain-rabbit-192.json'
$lunaGbrain = 'H:\AIagent\Luna\.paperclip\gbrain-luna-192.json'
foreach ($required in @($tsx, $serverHost, $seeder, $dispatcher, $credentialHelper, $supervisor,
    $rabbitGbrain, $lunaGbrain, 'H:\AIagent\Rabbit\AGENTS.md', 'H:\AIagent\Luna\AGENTS.md')) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required fixture dependency is missing: $required" }
}

New-Item -ItemType Directory -Path $instanceRoot, $logDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'repair-work.ps1') -Destination $fixtureRootPath
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'qa-work.ps1') -Destination $fixtureRootPath

[ordered]@{
  '$meta' = [ordered]@{
    version = 1
    updatedAt = [DateTimeOffset]::UtcNow.ToString('o')
    source = 'onboard'
  }
  server = [ordered]@{
    deploymentMode = 'local_trusted'
    exposure = 'private'
    bind = 'loopback'
    host = '127.0.0.1'
    port = $ServerPort
    serveUi = $false
  }
  database = [ordered]@{
    mode = 'embedded-postgres'
    embeddedPostgresPort = $DatabasePort
    embeddedPostgresDataDir = (Join-Path $instanceRoot 'db')
    backup = [ordered]@{ enabled = $false }
  }
  telemetry = [ordered]@{ enabled = $false }
  logging = [ordered]@{ mode = 'file' }
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $configPath -Encoding utf8

$savedEnvironment = @{}
$environmentNames = @(
  'PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PORT', 'SERVE_UI',
  'HEARTBEAT_SCHEDULER_ENABLED', 'PAPERCLIP_ANNOUNCEMENTS_ENABLED',
  'PAPERCLIP_MIGRATION_PROMPT', 'PAPERCLIP_MIGRATION_AUTO_APPLY',
  'PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED',
  'PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS', 'DATABASE_URL',
  'PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY', 'PAPERCLIP_RUN_ID',
  'PAPERCLIP_TASK_ID', 'PAPERCLIP_AGENT_ID', 'PAPERCLIP_COMPANY_ID',
  'PAP17_API_BASE'
)
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

$serviceProcess = $null
try {
  $env:PAPERCLIP_HOME = Join-Path $fixtureRootPath 'paperclip-home'
  $env:PAPERCLIP_INSTANCE_ID = $instanceId
  $env:PORT = [string]$ServerPort
  $env:SERVE_UI = 'false'
  $env:HEARTBEAT_SCHEDULER_ENABLED = 'false'
  $env:PAPERCLIP_ANNOUNCEMENTS_ENABLED = 'false'
  $env:PAPERCLIP_MIGRATION_PROMPT = 'never'
  $env:PAPERCLIP_MIGRATION_AUTO_APPLY = 'true'
  $env:PAPERCLIP_WORK_RECORD_WORKFLOW_V2_WRITES_ENABLED = 'true'
  $env:PAPERCLIP_WORK_RECORD_WORKFLOW_V2_COHORTS = '[{"companyId":"17000000-0000-4000-8000-000000000017","projectIds":["17000000-0000-4000-8000-000000000201"]}]'
  foreach ($name in @('DATABASE_URL', 'PAPERCLIP_API_URL', 'PAPERCLIP_API_KEY',
      'PAPERCLIP_RUN_ID', 'PAPERCLIP_TASK_ID', 'PAPERCLIP_AGENT_ID', 'PAPERCLIP_COMPANY_ID')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }

  $serviceProcess = Start-Process -FilePath $node `
    -ArgumentList @($tsx, $serverHost, $fixtureRootPath) `
    -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr

  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
  while (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
    if ($serviceProcess.HasExited) { throw "Fixture service exited $($serviceProcess.ExitCode); inspect $serverStderr" }
    if ([DateTimeOffset]::UtcNow -ge $deadline) { throw "Fixture service did not become ready within 120 seconds; inspect $serverStderr" }
    Start-Sleep -Milliseconds 250
    $serviceProcess.Refresh()
  }
  $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
  $health = Invoke-RestMethod -Uri "$($runtime.apiUrl)/api/health" -Method Get -TimeoutSec 10
  if ($health.status -ne 'ok') { throw 'Fixture service health check did not return status=ok.' }

  $repairToken = 'pcp_' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $qaToken = 'pcp_' + [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  $env:DATABASE_URL = [string]$runtime.databaseUrl
  $env:PAP17_REPAIR_TOKEN = $repairToken
  $env:PAP17_QA_TOKEN = $qaToken
  $env:PAP17_FIXTURE_IDS_PATH = $idsPath
  $env:PAP17_FIXTURE_ROOT = $fixtureRootPath
  & $node $tsx $seeder
  if ($LASTEXITCODE -ne 0) { throw "Fixture seeder exited $LASTEXITCODE." }

  $ids = Get-Content -Raw -LiteralPath $idsPath | ConvertFrom-Json
  $env:PAP17_API_BASE = [string]$runtime.apiUrl
  & $node $tsx $dispatcher
  if ($LASTEXITCODE -ne 0) { throw "Formal dispatch preparation exited $LASTEXITCODE." }
  $dispatch = Get-Content -Raw -LiteralPath (Join-Path $fixtureRootPath 'http-receipts\fixture-dispatch.json') | ConvertFrom-Json
  $preflight = Get-Content -Raw -LiteralPath (Join-Path $fixtureRootPath 'http-receipts\fixture-preflight.json') | ConvertFrom-Json
  if ($preflight.ready -ne $true) { throw 'Fixture service preflight did not declare ready.' }
  $repairCredentials = Join-Path $fixtureRootPath 'repair-member.dpapi'
  $qaCredentials = Join-Path $fixtureRootPath 'qa-member.dpapi'
  $repairDocument = @{ schemaVersion = 1; agents = @{ $ids.ids.repairAgentId = $repairToken } } | ConvertTo-Json -Compress
  $qaDocument = @{ schemaVersion = 1; agents = @{ $ids.ids.qaAgentId = $qaToken } } | ConvertTo-Json -Compress
  $repairProtected = $repairDocument | & powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $credentialHelper protect
  if ($LASTEXITCODE -ne 0 -or -not $repairProtected) { throw 'Failed to protect the repair member credential.' }
  $qaProtected = $qaDocument | & powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $credentialHelper protect
  if ($LASTEXITCODE -ne 0 -or -not $qaProtected) { throw 'Failed to protect the QA member credential.' }
  Set-Content -LiteralPath $repairCredentials -Value $repairProtected -NoNewline -Encoding ascii
  Set-Content -LiteralPath $qaCredentials -Value $qaProtected -NoNewline -Encoding ascii
  $repairToken = $null
  $qaToken = $null
  $repairDocument = $null
  $qaDocument = $null

  function Write-BridgeConfig(
    [string]$Path,
    [string]$AgentId,
    [string]$AgentName,
    [string]$DeviceId,
    [string]$CredentialsFile,
    [string]$GbrainRef,
    [string]$GbrainFile,
    [string]$Cwd,
    [string]$InstructionsFile
  ) {
    $workerHome = Join-Path $fixtureRootPath "workers\$AgentId"
    [ordered]@{
      schemaVersion = 3
      modelAuthMode = 'shared_user_codex'
      deviceId = $DeviceId
      workerHome = $workerHome
      apiBase = [string]$runtime.apiUrl
      gbrainMcpUrl = 'http://192.168.72.157:8787/mcp'
      companyId = [string]$ids.ids.companyId
      credentialsFile = $CredentialsFile
      pollIntervalMs = 20000
      agents = @([ordered]@{
        remoteAgentId = $AgentId
        remoteAgentName = $AgentName
        localAgentName = $AgentName
        gbrainEnvRef = $GbrainRef
        gbrainCredentialFile = $GbrainFile
        adapterType = 'codex_local'
        localAdapterConfig = [ordered]@{
          cwd = $Cwd
          command = $codex
          engine = 'cli'
          instructionsFilePath = $InstructionsFile
        }
        maxConcurrentRuns = 1
      })
      supervisorExecutable = $supervisor
    } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8
  }

  $repairConfig = Join-Path $fixtureRootPath 'bridge-repair-rabbit.json'
  $qaConfig = Join-Path $fixtureRootPath 'bridge-qa-luna.json'
  Write-BridgeConfig $repairConfig $ids.ids.repairAgentId 'Rabbit' $ids.ids.repairDeviceId `
    $repairCredentials 'GBRAIN_RABBIT_TOKEN' $rabbitGbrain 'H:\AIagent\Rabbit' 'H:\AIagent\Rabbit\AGENTS.md'
  Write-BridgeConfig $qaConfig $ids.ids.qaAgentId 'Luna' $ids.ids.qaDeviceId `
    $qaCredentials 'GBRAIN_LUNA_TOKEN' $lunaGbrain 'H:\AIagent\Luna' 'H:\AIagent\Luna\AGENTS.md'

  $runOnce = Join-Path $PSScriptRoot 'run-pilot-once-hidden.ps1'
  $evidenceDir = Join-Path $fixtureRootPath 'run-evidence'
  $stopScript = Join-Path $PSScriptRoot 'stop-pap17-g2-fixture.ps1'
  $cleanupScript = Join-Path $PSScriptRoot 'remove-pap17-g2-fixture.ps1'
  $manifestPath = Join-Path $fixtureRootPath 'fixture-manifest.json'
  [ordered]@{
    schemaVersion = 1
    fixtureId = 'PAP-17-G2'
    candidateCommit = $candidateCommit
    fixedBaseline = '8a45b24e8302d3f7bdc113eeb1f85c483e71ed8e'
    createdAt = [DateTimeOffset]::UtcNow.ToString('o')
    service = [ordered]@{
      pid = [int]$runtime.pid
      apiBase = [string]$runtime.apiUrl
      configPath = $configPath
      stdout = $serverStdout
      stderr = $serverStderr
    }
    database = [ordered]@{
      mode = 'embedded-postgres'
      host = '127.0.0.1'
      port = $DatabasePort
      dataDir = (Join-Path $instanceRoot 'db')
    }
    bridge = [ordered]@{
      repairConfig = $repairConfig
      qaConfig = $qaConfig
      repairCommand = "& '$runOnce' -Config '$repairConfig' -EvidenceDir '$evidenceDir' -Phase repair"
      qaCommand = "& '$runOnce' -Config '$qaConfig' -EvidenceDir '$evidenceDir' -Phase qa"
    }
    lifecycle = [ordered]@{
      stopCommand = "& '$stopScript' -FixtureRoot '$fixtureRootPath'"
      cleanupCommand = "& '$cleanupScript' -FixtureRoot '$fixtureRootPath' -ConfirmFixtureId 'PAP-17-G2'"
    }
    idsPath = $idsPath
    ids = [ordered]@{
      companyId = $ids.ids.companyId
      projectId = $ids.ids.projectId
      responsibleUserId = $ids.ids.responsibleUserId
      repairAgentId = $ids.ids.repairAgentId
      qaAgentId = $ids.ids.qaAgentId
      repairKeyId = $ids.ids.repairKeyId
      qaKeyId = $ids.ids.qaKeyId
      recordId = $dispatch.recordId
      issueId = $dispatch.issueId
      issueIdentifier = $dispatch.issueIdentifier
      issueLinkId = $dispatch.issueLinkId
      dispatchBatchId = $dispatch.dispatchBatchId
      repairWakeRequestId = $dispatch.repairWakeRequestId
      repairRunId = $dispatch.repairRunId
      cycleId = $dispatch.cycleId
      repairItemId = $dispatch.repairItemId
      qaItemId = $dispatch.qaItemId
    }
    queue = [ordered]@{
      repairRunId = $dispatch.repairRunId
      repairState = $dispatch.repairRunState
      qaRunId = $dispatch.qaRunId
      qaState = $dispatch.qaState
    }
    formalDispatch = [ordered]@{
      clientRequestId = $dispatch.dispatchClientRequestId
      receiptsDirectory = (Join-Path $fixtureRootPath 'http-receipts')
      preflightReceipt = (Join-Path $fixtureRootPath 'http-receipts\fixture-preflight.json')
    }
    isolation = [ordered]@{
      paperclip192Written = $false
      mainEngineeringWritten = $false
      bridgeStartedByPrepare = $false
      modelStartedByPrepare = $false
    }
  } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding utf8

  Get-Content -Raw -LiteralPath $manifestPath
} catch {
  if ($null -ne $serviceProcess -and -not $serviceProcess.HasExited) {
    @{ reason = 'prepare_failed'; requestedAt = [DateTimeOffset]::UtcNow.ToString('o') } |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixtureRootPath 'stop-request.json') -Encoding utf8
    [void]$serviceProcess.WaitForExit(30000)
  }
  throw
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }
  foreach ($name in @('PAP17_REPAIR_TOKEN', 'PAP17_QA_TOKEN', 'PAP17_FIXTURE_IDS_PATH', 'PAP17_FIXTURE_ROOT')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
}
