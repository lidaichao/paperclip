param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($settings.schemaVersion -ne 1) { throw '配置版本必须为 1。' }
if ($settings.localApiBase -ne 'http://127.0.0.1:3100') { throw '本地 Paperclip 地址必须是 http://127.0.0.1:3100。' }
throw '桥接尚未实现 Alice 服务端运行号、任务签领与本人 GR 密钥解析；禁止安装。请使用服务端管理的执行目标。'
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw '未找到 node.exe。' }

$serverHealth = Invoke-RestMethod -Uri ($settings.apiBase.TrimEnd('/') + '/api/health') -TimeoutSec 10
if ($serverHealth.status -ne 'ok') { throw 'Alice 服务器健康检查失败。' }
$localAgents = Invoke-RestMethod -Uri ($settings.localApiBase + '/api/companies/' + $settings.localCompanyId + '/agents') -TimeoutSec 10

$encrypted = (Get-Content -LiteralPath $settings.credentialsFile -Raw).Trim()
$helper = Join-Path $PSScriptRoot 'credential-helper.ps1'
$credentialsJson = $encrypted | & powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $helper unprotect
$credentials = $credentialsJson | ConvertFrom-Json

foreach ($agent in $settings.agents) {
  $token = $credentials.agents.PSObject.Properties[$agent.remoteAgentId].Value
  if ([string]::IsNullOrWhiteSpace($token)) { throw "缺少 $($agent.remoteAgentName) 的凭据。" }
  $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }
  $identity = Invoke-RestMethod -Uri ($settings.apiBase.TrimEnd('/') + '/api/agents/me') -Headers $headers -TimeoutSec 10
  if ($identity.id -ne $agent.remoteAgentId -or $identity.companyId -ne $settings.companyId) {
    throw "$($agent.remoteAgentName) 的服务器身份不匹配。"
  }
  $local = $localAgents | Where-Object { $_.name -eq $agent.localAgentName } | Select-Object -First 1
  if (-not $local) { throw "未找到本地智能体 $($agent.localAgentName)。" }
  if ($local.adapterType -ne $agent.adapterType) { throw "$($agent.localAgentName) 的适配器类型不匹配。" }
  if (-not (Test-Path -LiteralPath $local.adapterConfig.cwd -PathType Container)) { throw "$($agent.localAgentName) 的工作目录不存在。" }
  if (-not (Test-Path -LiteralPath $local.adapterConfig.command -PathType Leaf)) { throw "$($agent.localAgentName) 的命令不存在。" }
}

[pscustomobject]@{
  Ready = $true
  DryRun = [bool]$DryRun
  Server = $settings.apiBase
  AgentCount = $settings.agents.Count
  Message = '体检通过；未启动任何智能体任务。'
} | ConvertTo-Json
