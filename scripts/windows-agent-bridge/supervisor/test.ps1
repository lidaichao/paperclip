$ErrorActionPreference = 'Stop'
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq 'Core') { throw 'Windows is required.' }
$supervisor = & (Join-Path $PSScriptRoot 'build.ps1')
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('paperclip-supervisor-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$fake = Join-Path $testRoot 'TestChild.exe'
& $compiler /nologo /target:winexe /platform:x64 "/out:$fake" (Join-Path $PSScriptRoot 'TestChild.cs')
if ($LASTEXITCODE -ne 0) { throw 'Test child compilation failed.' }
$tracked = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
function Start-Hidden([string]$file, [string]$arguments) {
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $file
    $start.Arguments = $arguments
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Hidden process did not start.' }
    $tracked.Add($process)
    return $process
}
function Wait-File([string]$file) {
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while (-not (Test-Path -LiteralPath $file) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 50
    }
    if (-not (Test-Path -LiteralPath $file)) { throw "Timed out waiting for $file" }
}
function Identity([System.Diagnostics.Process]$process) {
    $reader = Start-Hidden $supervisor ("identity " + $process.Id)
    if (-not $reader.WaitForExit(5000) -or $reader.ExitCode -ne 0) { throw 'Bridge identity read failed.' }
    $parts = $reader.StandardOutput.ReadToEnd().Trim().Split(' ')
    if ($parts.Length -ne 3) { throw 'Invalid bridge identity output.' }
    return $parts
}
function Launch([System.Diagnostics.Process]$bridge, [string[]]$modelArgs,
    [bool]$wrongIdentity = $false, [string]$modelInput = '') {
    $identity = Identity $bridge
    $runId = [guid]::NewGuid().ToString('D')
    $leaseId = [guid]::NewGuid().ToString('D')
    $nonce = [guid]::NewGuid().ToString('D')
    $created = [ulong]$identity[1]
    if ($wrongIdentity) { $created++ }
    $header = @{
        runId = $runId; leaseId = $leaseId; deviceId = 'test-device'; nonce = $nonce;
        bridgePid = [int]$identity[0]; bridgeCreationFileTime = [string]$created;
        bridgeSessionId = [int]$identity[2]; receiptDir = $testRoot;
        cwd = $testRoot; executable = $fake; args = $modelArgs;
        env = @{ SystemRoot = $env:SystemRoot; WINDIR = $env:WINDIR; PATH = $env:PATH;
            TEMP = $testRoot; TMP = $testRoot; SUPERVISOR_TEST = 'test-only-env-secret' }
    }
    $json = $header | ConvertTo-Json -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $process = Start-Hidden $supervisor 'run'
    $stream = $process.StandardInput.BaseStream
    $length = [BitConverter]::GetBytes([int]$bytes.Length)
    $stream.Write($length, 0, $length.Length)
    $stream.Write($bytes, 0, $bytes.Length)
    $inputBytes = [Text.Encoding]::UTF8.GetBytes($modelInput)
    if ($inputBytes.Length -gt 0) { $stream.Write($inputBytes, 0, $inputBytes.Length) }
    $stream.Flush()
    $stream.Close()
    return @{ Process = $process; RunId = $runId;
        LeaseId = $leaseId; Nonce = $nonce;
        Ready = (Join-Path $testRoot ($runId + '.ready.json'));
        Receipt = (Join-Path $testRoot ($runId + '.stopped.json')) }
}
function Assert-Gone([int]$targetPid) {
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 50
    }
    throw "Test descendant $targetPid is still alive."
}
try {
    $bridge = Start-Hidden $fake 'sleep 60000'
    $marker = Join-Path $testRoot 'descendant-1.txt'
    $run = Launch $bridge @('tree-exit', $marker, '60000')
    Wait-File $run.Ready
    Wait-File $marker
    if (-not $run.Process.WaitForExit(30000)) { throw 'Supervisor did not stop lingering descendants.' }
    Wait-File $run.Receipt
    $receipt = Get-Content -LiteralPath $run.Receipt -Raw | ConvertFrom-Json
    if ($receipt.runId -ne $run.RunId -or $receipt.leaseId -ne $run.LeaseId -or
        $receipt.nonce -ne $run.Nonce -or $receipt.deviceId -ne 'test-device' -or
        $receipt.activeProcesses -ne 0 -or
        $receipt.cause -ne 'descendant_timeout') { throw 'Invalid descendant drain receipt.' }
    if ($run.Process.ExitCode -eq 0) { throw 'Descendant timeout returned success.' }
    Assert-Gone ([int](Get-Content -LiteralPath $marker -Raw))
    Write-Output 'PASS descendant drained before receipt'

    $run2 = Launch $bridge @('sleep', '60000')
    Wait-File $run2.Ready
    $ready2 = Get-Content -LiteralPath $run2.Ready -Raw | ConvertFrom-Json
    Stop-Process -Id $bridge.Id -Force
    if (-not $run2.Process.WaitForExit(30000)) { throw 'Supervisor did not react to bridge exit.' }
    Wait-File $run2.Receipt
    $receipt2 = Get-Content -LiteralPath $run2.Receipt -Raw | ConvertFrom-Json
    if ($receipt2.cause -ne 'bridge_exit' -or $receipt2.activeProcesses -ne 0) {
        throw 'Invalid bridge crash receipt.'
    }
    Assert-Gone ([int]$ready2.modelPid)
    Write-Output 'PASS bridge crash drains job'

    $bridge3 = Start-Hidden $fake 'sleep 60000'
    $marker3 = Join-Path $testRoot 'descendant-3.txt'
    $run3 = Launch $bridge3 @('tree-wait', $marker3, '60000')
    Wait-File $run3.Ready
    Wait-File $marker3
    $ready3 = Get-Content -LiteralPath $run3.Ready -Raw | ConvertFrom-Json
    Stop-Process -Id $run3.Process.Id -Force
    Assert-Gone ([int]$ready3.modelPid)
    Assert-Gone ([int](Get-Content -LiteralPath $marker3 -Raw))
    if (Test-Path -LiteralPath $run3.Receipt) { throw 'Crushed supervisor issued an unproven receipt.' }
    Write-Output 'PASS supervisor crash kills tree without false receipt'

    $wrong = Launch $bridge3 @('sleep', '1000') $true
    if (-not $wrong.Process.WaitForExit(5000) -or $wrong.Process.ExitCode -ne 70 -or
        (Test-Path -LiteralPath $wrong.Ready)) {
        throw 'Wrong bridge identity launched a model.'
    }
    Write-Output 'PASS stale bridge identity rejected before launch'

    $bridge4 = Start-Hidden $fake 'sleep 60000'
    $normal = Launch $bridge4 @('sleep', '100')
    if (-not $normal.Process.WaitForExit(10000)) { throw 'Normal model did not finish.' }
    Wait-File $normal.Receipt
    $normalReceipt = Get-Content -LiteralPath $normal.Receipt -Raw | ConvertFrom-Json
    if ($normalReceipt.cause -ne 'model_exit' -or $normalReceipt.modelExitCode -ne 0 -or
        $normalReceipt.activeProcesses -ne 0) { throw 'Normal finish receipt is invalid.' }
    Write-Output 'PASS normal model exit drains job'

    $cancelRun = Launch $bridge4 @('sleep', '60000')
    Wait-File $cancelRun.Ready
    $cancelReady = Get-Content -LiteralPath $cancelRun.Ready -Raw | ConvertFrom-Json
    $cancelCommand = Start-Hidden $supervisor ("cancel " + $cancelReady.cancelEvent)
    if (-not $cancelCommand.WaitForExit(5000) -or $cancelCommand.ExitCode -ne 0) {
        throw 'Cancellation signal failed.'
    }
    if (-not $cancelRun.Process.WaitForExit(30000)) { throw 'Cancelled job did not drain.' }
    Wait-File $cancelRun.Receipt
    $cancelReceipt = Get-Content -LiteralPath $cancelRun.Receipt -Raw | ConvertFrom-Json
    if ($cancelReceipt.cause -ne 'cancelled' -or $cancelReceipt.activeProcesses -ne 0) {
        throw 'Cancellation receipt is invalid.'
    }
    Assert-Gone ([int]$cancelReady.modelPid)
    Write-Output 'PASS explicit cancellation drains job'

    $failed = Launch $bridge4 @('exit', '23')
    if (-not $failed.Process.WaitForExit(10000) -or $failed.Process.ExitCode -ne 23) {
        throw 'Model exit code was not forwarded.'
    }
    Wait-File $failed.Receipt
    $failedReceipt = Get-Content -LiteralPath $failed.Receipt -Raw | ConvertFrom-Json
    if ($failedReceipt.modelExitCode -ne 23 -or $failedReceipt.activeProcesses -ne 0) {
        throw 'Nonzero model receipt is invalid.'
    }
    Write-Output 'PASS nonzero model exit code forwarded'

    $promptMarker = Join-Path $testRoot 'stdin-marker.txt'
    $prompt = 'test-only-secret-input-through-pipe'
    $inputRun = Launch $bridge4 @('stdin-marker', $promptMarker) $false $prompt
    if (-not $inputRun.Process.WaitForExit(10000) -or $inputRun.Process.ExitCode -ne 0) {
        throw 'Model stdin pipe did not complete.'
    }
    if ((Get-Content -LiteralPath $promptMarker -Raw) -ne $prompt) {
        throw 'Model stdin was not forwarded exactly.'
    }
    Write-Output 'PASS model stdin passed by pipe'

    $envMarker = Join-Path $testRoot 'env-marker.txt'
    $envRun = Launch $bridge4 @('env-marker', $envMarker)
    if (-not $envRun.Process.WaitForExit(10000) -or $envRun.Process.ExitCode -ne 0 -or
        (Get-Content -LiteralPath $envMarker -Raw) -ne 'test-only-env-secret') {
        throw 'Explicit model environment was not forwarded.'
    }
    if ((Get-Content -LiteralPath $envRun.Ready -Raw) -match 'test-only-env-secret' -or
        (Get-Content -LiteralPath $envRun.Receipt -Raw) -match 'test-only-env-secret') {
        throw 'Model environment leaked into a receipt.'
    }
    Write-Output 'PASS model environment passed by pipe without receipt leak'

    $argMarker = Join-Path $testRoot 'arg-marker.txt'
    $argRun = Launch $bridge4 @('arg-marker', $argMarker, 'argument with spaces')
    if (-not $argRun.Process.WaitForExit(10000) -or $argRun.Process.ExitCode -ne 0 -or
        (Get-Content -LiteralPath $argMarker -Raw) -ne 'argument with spaces') {
        throw 'Quoted model argument was not forwarded.'
    }
    Write-Output 'PASS model argument with spaces forwarded'
} finally {
    foreach ($process in $tracked) {
        try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit(2000) | Out-Null } }
        catch { }
        $process.Dispose()
    }
    # The target is the unique directory generated above, under the OS temp root.
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedRoot) -match '^paperclip-supervisor-test-[0-9a-f]{32}$')) {
        throw 'Refusing unsafe test cleanup target.'
    }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}
