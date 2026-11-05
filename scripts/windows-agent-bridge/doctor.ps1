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
# until ordinary writes are fenced by the lease and per-agent GB credentials
# can be resolved without embedding secrets in config.
throw '桥接普通写入的租约围栏与本人 GB 密钥解析尚未完成；禁止安装。'
