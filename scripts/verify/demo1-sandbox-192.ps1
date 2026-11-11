param(
  [ValidateSet('Inspect', 'Seed', 'Verify', 'Reset')]
  [string]$Mode = 'Inspect',
  [string]$ServerBase = 'http://192.168.72.157:3100',
  [string]$ProjectName = '人机协作 Demo 1',
  [string]$EvidenceDirectory = 'H:\project\Papercilp\development-docs\evidence\2026-11-11-demo1-sandbox-192'
)

$ErrorActionPreference = 'Stop'
$CompanyId = ''
$ProjectId = ''
$Failures = [System.Collections.Generic.List[string]]::new()
$Passes = [System.Collections.Generic.List[string]]::new()
$Members = [ordered]@{
  'Luna' = 'H:\AIagent\Luna'
  'Rabbit' = 'H:\AIagent\Rabbit'
  '卡罗尔' = 'H:\AIagent\Carroll'
  'Belle' = 'H:\AIagent\Belle'
  'Ada' = 'H:\AIagent\Ada'
  'Miya' = 'H:\AIagent\Miya'
  'Monet' = 'H:\AIagent\Monet'
}
$ManifestPath = Join-Path $EvidenceDirectory 'manifest.json'
$TempDirectory = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path '.tmp\demo1-sandbox-192'

function Add-Pass([string]$Message) {
  $Passes.Add($Message)
  Write-Host "PASS  $Message" -ForegroundColor Green
}

function Add-Failure([string]$Message) {
  $Failures.Add($Message)
  Write-Host "FAIL  $Message" -ForegroundColor Red
}

function Invoke-MemberApi {
  param(
    [Parameter(Mandatory)][string]$Member,
    [Parameter(Mandatory)][ValidateSet('GET','POST','PATCH','PUT','DELETE')][string]$Method,
    [Parameter(Mandatory)][string]$Path,
    [object]$Body = $null
  )
  $Workspace = $Members[$Member]
  if (-not $Workspace) { throw "Unknown member: $Member" }
  $Helper = Join-Path $Workspace 'scripts\paperclip\invoke-api.ps1'
  if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw "Missing Paperclip helper for ${Member}: $Helper" }
  $Arguments = @{ Method = $Method; Path = $Path }
  $BodyPath = $null
  if ($null -ne $Body) {
    New-Item -ItemType Directory -Force -Path $TempDirectory | Out-Null
    $BodyPath = Join-Path $TempDirectory ("body-{0}.json" -f [guid]::NewGuid())
    $Body | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $BodyPath -Encoding UTF8
    $Arguments.BodyFile = $BodyPath
  }
  try {
    $Raw = (& $Helper @Arguments | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($Raw)) { return @() }
    $Parsed = $Raw | ConvertFrom-Json
    if ($Parsed -is [System.Array]) {
      foreach ($Item in $Parsed) { Write-Output $Item }
      return
    }
    return $Parsed
  } finally {
    if ($BodyPath -and (Test-Path -LiteralPath $BodyPath)) { Remove-Item -LiteralPath $BodyPath -Force }
  }
}

function Read-Manifest {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Manifest missing: $ManifestPath" }
  return Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Write-Manifest([object]$Manifest) {
  New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
  $Manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $ManifestPath -Encoding UTF8
}

function Inspect-Sandbox {
  try {
    $Health = Invoke-RestMethod -Method GET -Uri ($ServerBase.TrimEnd('/') + '/api/health') -TimeoutSec 15
    if ($Health.status -eq 'ok') { Add-Pass "192 health=ok, commit=$($Health.commit)" } else { Add-Failure "192 health=$($Health.status)" }
    if ($Health.deploymentMode -eq 'authenticated') { Add-Pass '认证模式为 authenticated' } else { Add-Failure "认证模式异常：$($Health.deploymentMode)" }
    if ($Health.databaseBackup.status -eq 'ok') { Add-Pass '数据库备份状态为 ok' } else { Add-Failure "数据库备份异常：$($Health.databaseBackup.status)" }
  } catch {
    Add-Failure "192 健康检查失败：$($_.Exception.Message)"
  }

  $Identities = [ordered]@{}
  foreach ($Member in $Members.Keys) {
    try {
      $Identity = Invoke-MemberApi -Member $Member -Method GET -Path '/api/agents/me'
      $Identities[$Member] = $Identity
      if ($Identity.name -eq $Member) { Add-Pass "$Member 回读本人身份" } else { Add-Failure "$Member 身份错配为 $($Identity.name)" }
    } catch {
      Add-Failure "$Member 身份检查失败：$($_.Exception.Message)"
    }
  }
  if (-not $Identities['Luna']) { return $null }
  $script:CompanyId = [string]$Identities['Luna'].companyId

  try {
    $Projects = @(Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/companies/$CompanyId/projects")
    $Matches = @($Projects | Where-Object { $_.name -eq $ProjectName -and -not $_.archivedAt })
    if ($Matches.Count -ne 1) {
      Add-Failure "项目 '$ProjectName' 应唯一，实际 $($Matches.Count) 个；可见项目：$((@($Projects | ForEach-Object { $_.name }) -join ' | '))"
      return $null
    }
    $script:ProjectId = [string]$Matches[0].id
    Add-Pass "项目唯一：$ProjectName ($ProjectId)"
  } catch {
    Add-Failure "项目检查失败：$($_.Exception.Message)"
    return $null
  }

  $Issues = @()
  try {
    $Issues = @(Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/companies/$CompanyId/issues?projectId=$ProjectId&limit=200")
    $Unexpected = @($Issues | Where-Object { -not $_.title.StartsWith('[TESTLAB]') })
    if ($Unexpected.Count -eq 0) { Add-Pass "项目内 $($Issues.Count) 张任务全部属于 [TESTLAB]" }
    else { Add-Failure "项目混入 $($Unexpected.Count) 张非 [TESTLAB] 任务：$($Unexpected.identifier -join ', ')" }
  } catch {
    Add-Failure "项目任务检查失败：$($_.Exception.Message)"
  }

  return [pscustomobject]@{
    health = $Health
    companyId = $CompanyId
    projectId = $ProjectId
    identities = $Identities
    issues = $Issues
  }
}

function Seed-Sandbox([object]$Context) {
  if ($Failures.Count -gt 0 -or -not $Context) { throw 'Inspect failed; refusing to seed.' }
  $Definitions = @(
    @{ title='[TESTLAB] Demo 1:1 功能回归总控'; description='专用测试协调卡。默认不指派、不唤醒、不派发真实成员。'; priority='high'; member='Luna'; parentTitle=$null },
    @{ title='[TESTLAB] Demo 业务合同与测试数据'; description='覆盖计划、甘特图、缺陷和个人待办合同。'; priority='high'; member='Luna'; parentTitle='[TESTLAB] Demo 1:1 功能回归总控' },
    @{ title='[TESTLAB] 原生 Paperclip 无损回归'; description='验证原生任务、评论、附件、状态、搜索、审计、权限和运行。'; priority='high'; member='Luna'; parentTitle='[TESTLAB] Demo 1:1 功能回归总控' },
    @{ title='[TESTLAB] 四视图 UI/UX 1:1 差距验收'; description='验证四种视口与固定布局。'; priority='high'; member='Luna'; parentTitle='[TESTLAB] Demo 1:1 功能回归总控' },
    @{ title='[TESTLAB] 工作包依赖、返工与 QA/PO 闭环'; description='验证派发、依赖、PO/QA 和返工闭环。'; priority='high'; member='Luna'; parentTitle='[TESTLAB] Demo 1:1 功能回归总控' }
  )
  foreach ($Member in $Members.Keys) {
    $IdentityTitle = if ($Member -eq '卡罗尔') {
      '[TESTLAB][IDENTITY] 卡罗尔建卡与对话验证'
    } else {
      "[TESTLAB][IDENTITY] $Member 建卡与对话验证"
    }
    $Definitions += @{
      title = $IdentityTitle
      description = "测试专用：验证本机 $Member 以本人身份建卡和评论。禁止派发、禁止执行。"
      priority = 'low'
      member = $Member
      parentTitle = '[TESTLAB] Demo 1:1 功能回归总控'
    }
  }

  $ByTitle = @{}
  foreach ($Issue in $Context.issues) { $ByTitle[$Issue.title] = $Issue }
  $Entries = @()
  foreach ($Definition in $Definitions) {
    $Existing = $ByTitle[$Definition.title]
    if (-not $Existing) {
      $Parent = if ($Definition.parentTitle) { $ByTitle[$Definition.parentTitle] } else { $null }
      if ($Definition.parentTitle -and -not $Parent) { throw "Parent missing for $($Definition.title)" }
      $Existing = Invoke-MemberApi -Member $Definition.member -Method POST -Path "/api/companies/$CompanyId/issues" -Body @{
        title = $Definition.title
        description = $Definition.description
        priority = $Definition.priority
        status = 'backlog'
        projectId = $ProjectId
        parentId = if ($Parent) { $Parent.id } else { $null }
      }
      $ByTitle[$Definition.title] = $Existing
      Add-Pass "创建 $($Existing.identifier)（$($Definition.member)）"
    }
    $Identity = $Context.identities[$Definition.member]
    if ($Existing.createdByAgentId -ne $Identity.id -or $Existing.createdByUserId) {
      Add-Failure "$($Existing.identifier) 创建者不是 $($Definition.member)"
    }
    if ($Definition.title.StartsWith('[TESTLAB][IDENTITY]')) {
      $Comments = @(Invoke-MemberApi -Member $Definition.member -Method GET -Path "/api/issues/$($Existing.id)/comments")
      if (-not ($Comments | Where-Object { $_.authorAgentId -eq $Identity.id })) {
        $Comment = Invoke-MemberApi -Member $Definition.member -Method POST -Path "/api/issues/$($Existing.id)/comments" -Body @{
          body = '[TESTLAB] 本机成员本人评论链验证：必须保留当前 Agent 作者，且不得触发任务执行。'
        }
        if ($Comment.authorAgentId -eq $Identity.id -and -not $Comment.authorUserId) { Add-Pass "$($Definition.member) 本人评论写入" }
        else { Add-Failure "$($Definition.member) 评论署名错配" }
      }
    }
    $Entries += [ordered]@{
      id = $Existing.id
      identifier = $Existing.identifier
      title = $Existing.title
      parentId = $Existing.parentId
      createdByAgentId = $Existing.createdByAgentId
      expectedCreator = $Definition.member
      cleanup = 'cancel_only_by_manifest_id'
    }
  }
  $Manifest = [ordered]@{
    schemaVersion = 1
    server = $ServerBase
    companyId = $CompanyId
    projectId = $ProjectId
    projectName = $ProjectName
    createdAt = (Get-Date).ToString('o')
    nativeIssues = $Entries
    workRecords = @()
    controlledDispatch = @{ verified = $false; issueId = $null; agentId = $null }
    cleanupPolicy = 'Only exact IDs in this manifest may be cancelled or removed.'
  }
  Write-Manifest $Manifest
  Add-Pass "manifest 已写入 $ManifestPath"
}

function Verify-Sandbox([object]$Context) {
  if (-not $Context) { return }
  $Manifest = Read-Manifest
  if ($Manifest.projectId -ne $Context.projectId) { Add-Failure 'manifest 项目 ID 与实时查询不一致' }
  foreach ($Entry in @($Manifest.nativeIssues)) {
    try {
      $Issue = Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/issues/$($Entry.id)"
      $Identity = $Context.identities[$Entry.expectedCreator]
      if ($Issue.createdByAgentId -eq $Identity.id -and -not $Issue.createdByUserId) { Add-Pass "$($Issue.identifier) 创建者=$($Entry.expectedCreator)" }
      else { Add-Failure "$($Issue.identifier) 创建者归属错误" }
      if (-not $Issue.assigneeAgentId -and -not $Issue.executionRunId -and -not $Issue.checkoutRunId) { Add-Pass "$($Issue.identifier) 未指派且未执行" }
      else { Add-Failure "$($Issue.identifier) 意外被指派或执行" }
      if ($Entry.title.StartsWith('[TESTLAB][IDENTITY]')) {
        $Comments = @(Invoke-MemberApi -Member $Entry.expectedCreator -Method GET -Path "/api/issues/$($Entry.id)/comments")
        if ($Comments | Where-Object { $_.authorAgentId -eq $Identity.id -and -not $_.authorUserId }) { Add-Pass "$($Issue.identifier) 本人评论可回读" }
        else { Add-Failure "$($Issue.identifier) 缺少本人评论" }
      }
    } catch {
      Add-Failure "$($Entry.identifier) 回读失败：$($_.Exception.Message)"
    }
  }
  try {
    $WorkRecords = @(Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/companies/$CompanyId/projects/$ProjectId/work-records")
    $LiveById = @{}
    foreach ($Record in $WorkRecords) { $LiveById[[string]$Record.id] = $Record }
    if (@($Manifest.workRecords).Count -eq 0) {
      Add-Failure '工作记录数据集尚未写入 manifest'
    } else {
      foreach ($Expected in @($Manifest.workRecords)) {
        $Record = $LiveById[[string]$Expected.id]
        if (-not $Record) {
          Add-Failure "$($Expected.recordIdentifier) 工作记录不存在"
          continue
        }
        if ($Record.title -eq $Expected.title -and $Record.kind -eq $Expected.kind -and $Record.createdByUserId -eq $Manifest.testUserId -and -not $Record.createdByAgentId) {
          Add-Pass "$($Record.recordIdentifier) 数据与测试用户归属正确"
        } else {
          Add-Failure "$($Expected.recordIdentifier) 标题、类型或创建者归属错误"
        }
      }
    }
  } catch {
    Add-Failure "工作记录接口未通过：$($_.Exception.Message)"
  }
  if ($Manifest.controlledDispatch.verified -ne $true) {
    Add-Failure '受控派发尚未验证；禁止宣称 192 全链路通过'
    return
  }
  try {
    $Idempotency = $Manifest.controlledDispatch.idempotency
    $DispatchReadback = Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/companies/$CompanyId/projects/$ProjectId/work-records/$($Idempotency.recordId)/dispatch-requests/$($Idempotency.clientRequestId)"
    if ($DispatchReadback.issueId -eq $Idempotency.issueId) { Add-Pass '派发幂等键稳定回读同一原生任务' }
    else { Add-Failure '派发幂等键回读的原生任务不一致' }

    $Execution = $Manifest.controlledDispatch.execution
    $Issue = Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/issues/$($Execution.issueId)"
    $Comments = @(Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/issues/$($Execution.issueId)/comments")
    $Run = Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/heartbeat-runs/$($Execution.runId)"
    if ($Issue.status -eq $Execution.expectedIssueStatus) { Add-Pass "$($Execution.issueIdentifier) 受控派发任务已完成" }
    else { Add-Failure "$($Execution.issueIdentifier) 状态应为 $($Execution.expectedIssueStatus)，实际 $($Issue.status)" }
    if ($Run.status -eq $Execution.expectedRunStatus -and $Run.agentId -eq $Manifest.controlledDispatch.agentId) { Add-Pass '惰性测试 Agent 运行成功且身份正确' }
    else { Add-Failure '惰性测试 Agent 运行状态或身份错误' }
    if ($Comments | Where-Object { $_.body -eq $Execution.commentMarker -and $_.authorAgentId -eq $Manifest.controlledDispatch.agentId -and -not $_.authorUserId }) {
      Add-Pass '受控派发对话由测试 Agent 本人回写'
    } else {
      Add-Failure '缺少测试 Agent 本人署名的受控派发对话'
    }
    if ($Comments | Where-Object { $_.id -eq $Execution.boardCommentId -and $_.body -eq $Execution.boardCommentMarker -and $_.authorUserId -eq $Manifest.testUserId -and -not $_.authorAgentId }) {
      Add-Pass '看板用户对话可发送且署名正确'
    } else {
      Add-Failure '看板用户对话发送或署名验证失败'
    }
  } catch {
    Add-Failure "受控派发证据回读失败：$($_.Exception.Message)"
  }
}

function Reset-Sandbox([object]$Context) {
  if (-not $Context) { throw 'Inspect failed; refusing to reset.' }
  $Manifest = Read-Manifest
  foreach ($Entry in @($Manifest.nativeIssues) | Sort-Object { if ($_.parentId) { 0 } else { 1 } }) {
    $Issue = Invoke-MemberApi -Member 'Luna' -Method GET -Path "/api/issues/$($Entry.id)"
    if (-not $Issue.title.StartsWith('[TESTLAB]')) { throw "Refusing to reset non-test issue $($Issue.identifier)" }
    if ($Issue.status -ne 'cancelled') {
      $null = Invoke-MemberApi -Member 'Luna' -Method PATCH -Path "/api/issues/$($Issue.id)" -Body @{ status = 'cancelled' }
      Add-Pass "取消 $($Issue.identifier)"
    }
  }
}

$Context = Inspect-Sandbox
switch ($Mode) {
  'Inspect' { }
  'Seed' { Seed-Sandbox $Context }
  'Verify' { Verify-Sandbox $Context }
  'Reset' { Reset-Sandbox $Context }
}

$Report = [ordered]@{
  mode = $Mode
  checkedAt = (Get-Date).ToString('o')
  server = $ServerBase
  companyId = $CompanyId
  projectId = $ProjectId
  passCount = $Passes.Count
  failureCount = $Failures.Count
  passes = @($Passes)
  failures = @($Failures)
}
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$Report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory "last-$($Mode.ToLowerInvariant()).json") -Encoding UTF8
if ($Failures.Count -gt 0) { exit 1 }
