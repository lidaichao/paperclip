param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($settings.schemaVersion -ne 3) { throw '桥接配置版本必须为 3。' }
if ($settings.agents.Count -ne 1) { throw '每个本机工作器只能配置一名智能体。' }
if ($settings.PSObject.Properties.Name -contains 'localApiBase' -or
    $settings.PSObject.Properties.Name -contains 'localCompanyId') {
  throw '旧版 127 Paperclip 配置已停用。'
}
if (-not (Test-Path -LiteralPath $settings.credentialsFile -PathType Leaf)) {
  throw '成员凭据文件不存在。'
}
if (-not (Test-Path -LiteralPath $settings.supervisorExecutable -PathType Leaf)) {
  throw 'Windows 进程树监督器不存在。'
}
$adapterCommand = $settings.agents[0].localAdapterConfig.command
if (-not $adapterCommand -or -not (Test-Path -LiteralPath $adapterCommand -PathType Leaf)) {
  throw '本机模型命令不存在。'
}
$health = Invoke-RestMethod -Method Get -Uri ($settings.apiBase.TrimEnd('/') + '/api/health') -TimeoutSec 5
if ($health.status -ne 'ok') { throw 'Paperclip 服务健康检查未通过。' }
Write-Output ('桥接预检通过：' + $settings.agents[0].remoteAgentName)
