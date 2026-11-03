param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('protect', 'unprotect')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('AliceWindowsAgentBridge:v1')

if ($Mode -eq 'protect') {
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $entropy,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Console]::Out.Write([Convert]::ToBase64String($protected))
    }
    finally {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    exit 0
}

$cipherBytes = [Convert]::FromBase64String($inputText.Trim())
$plainBytes = $null
try {
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $cipherBytes,
        $entropy,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
}
finally {
    if ($null -ne $plainBytes) {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
    [Array]::Clear($cipherBytes, 0, $cipherBytes.Length)
}

