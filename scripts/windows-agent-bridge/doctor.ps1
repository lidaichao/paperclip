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

# A local config is parsed by config.ts, but no bridge process may be installed
# until ordinary writes are fenced by the lease, member identity is verified,
# and a safe model-auth path is verified. Never copy a rotating shared login.
throw '普通写入租约围栏、本人 GB 身份和模型订阅安全隔离尚未验收；禁止安装。'
