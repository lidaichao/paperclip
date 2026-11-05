param(
  [Parameter(Mandatory = $true)][string]$Config,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$configPath = (Resolve-Path $Config).Path
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($settings.schemaVersion -ne 2) { throw '桥接配置版本必须为 2。' }
if ($settings.PSObject.Properties.Name -contains 'localApiBase' -or
    $settings.PSObject.Properties.Name -contains 'localCompanyId') {
  throw '旧版 127 Paperclip 配置已停用。'
}

# A local config is parsed by config.ts, but no bridge process may be installed
# until 192 can issue a real run ID and an authenticated execution lease.
throw '桥接尚未实现 192 服务端运行号、任务签领与本人 GB 密钥解析；禁止安装。'
