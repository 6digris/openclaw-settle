# Diagnostic-only on a disposable hosted VM. This does not qualify a released-driver upgrade.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CandidateRoot,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedHead,
    [Parameter(Mandatory = $true)][string]$EvidenceRoot
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'Disposable hosted Windows with PowerShell7 required.' }
$CandidateRoot = [IO.Path]::GetFullPath($CandidateRoot)
$EvidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
$observedHead = (& git -C $CandidateRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $observedHead -cne $ExpectedHead -or $env:PROOF_WORKFLOW_SHA -cne $ExpectedHead) { throw 'Exact workflow/source identity required.' }
if (@(& git -C $CandidateRoot status --porcelain=v1 --untracked-files=all).Count -or $LASTEXITCODE -ne 0) { throw 'Source is dirty.' }
New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$root = Join-Path $env:RUNNER_TEMP ('openclaw-installed-command-diagnostic-' + [guid]::NewGuid().ToString('N'))
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$engine = (Get-Process -Id $PID).Path
$names = @('USERPROFILE','OPENCLAW_HOME','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_GIT_DIR','APPDATA','LOCALAPPDATA','NPM_CONFIG_PREFIX','npm_config_prefix','Path','TEMP','TMP')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
$userPath = [Environment]::GetEnvironmentVariable('Path','User')
$gateway = $null
$result = [ordered]@{ scope='diagnostic only; not released-driver acceptance'; sourceSha=$ExpectedHead; workflowSha=$env:PROOF_WORKFLOW_SHA; runId=$env:GITHUB_RUN_ID; runAttempt=$env:GITHUB_RUN_ATTEMPT; result='running'; commands=@(); unjoined=@(); cleanup='pending' }
function Save-Diagnostic {
    $pending = Join-Path $EvidenceRoot 'result.json.pending'
    $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $pending -Encoding UTF8
    [IO.File]::Move($pending, (Join-Path $EvidenceRoot 'result.json'), $true)
}
function Save-OwnedProcessTree {
    param([int]$RootPid, [string]$Name)
    try {
        $all = @(Get-CimInstance Win32_Process)
        $ids = [Collections.Generic.HashSet[int]]::new(); [void]$ids.Add($RootPid)
        do {
            $changed = $false
            foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $changed = $true } }
        } while ($changed)
        # Command lines and environment can contain credentials; retain only process identity/timing.
        @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $EvidenceRoot "$Name.processes.json")
    } catch { $script:result.processCaptureError = $_.Exception.Message }
}
function Invoke-Diagnostic {
    param([string]$Name,[string]$File,[string[]]$Arguments,[ValidateRange(1,1200)][int]$Seconds=120,[switch]$Required)
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName=$File; $info.WorkingDirectory=$root; $info.UseShellExecute=$false
    $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.CreateNoWindow=$true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $child=[Diagnostics.Process]::new(); $child.StartInfo=$info
    $started=$false; $stdoutTask=$null; $stderrTask=$null
    $record=[ordered]@{ name=$Name; pid=$null; completed=$false; processExited=$false; outputDrained=$false; exitCode=$null; elapsedMs=0 }
    $result.commands += $record
    Save-Diagnostic
    try {
        if (-not $child.Start()) { throw "$Name did not start." }
        $started=$true; $record.pid=$child.Id
        $stdoutTask=$child.StandardOutput.ReadToEndAsync(); $stderrTask=$child.StandardError.ReadToEndAsync()
        Save-Diagnostic
        $record.processExited=$child.WaitForExit([int][Math]::Max(1,$Seconds*1000-$watch.ElapsedMilliseconds))
        if ($record.processExited) {
            $record.outputDrained=[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask,$stderrTask),[int][Math]::Max(1,$Seconds*1000-$watch.ElapsedMilliseconds))
        }
        $record.completed=$record.processExited -and $record.outputDrained
        if (-not $record.completed) { Save-OwnedProcessTree -RootPid $child.Id -Name $Name }
    } finally {
        try {
            if ($started) {
                try {
                    if (-not $child.HasExited) { $child.Kill($true) }
                    $joined=$child.WaitForExit(10000)
                    $drained=[Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask,$stderrTask),10000)
                    if (-not $joined -or -not $drained) { $result.unjoined += $Name }
                    if ($child.HasExited) { $record.exitCode=$child.ExitCode }
                } catch { $result.unjoined += $Name; $record.cleanupError=$_.Exception.Message }
                foreach ($stream in @(@('stdout',$stdoutTask),@('stderr',$stderrTask))) {
                    $contents=if ($null -ne $stream[1] -and $stream[1].IsCompletedSuccessfully) { $stream[1].GetAwaiter().GetResult() } else { '[diagnostic stream unavailable: drain incomplete]' }
                    [IO.File]::WriteAllText((Join-Path $EvidenceRoot ($Name+'.'+$stream[0]+'.log')),$contents)
                }
            }
        } finally {
            $record.elapsedMs=$watch.ElapsedMilliseconds
            $child.Dispose()
            Save-Diagnostic
        }
    }
    if ($Required -and (-not $record.completed -or $record.exitCode -ne 0)) { throw "$Name did not complete successfully." }
}
function Quote-PSLiteral { param([string]$Value) "'" + $Value.Replace("'", "''") + "'" }
$result.node=@{path=$node; version=(& $node --version); sha256=(Get-FileHash $node -Algorithm SHA256).Hash.ToLowerInvariant()}
$failure = $null
try {
    $profile = Join-Path $root 'profile'; $prefix = Join-Path $root 'npm'; $temp = Join-Path $root 'temp'
    New-Item -ItemType Directory -Force -Path @($root,$profile,$prefix,$temp) | Out-Null
    $env:USERPROFILE=$profile; $env:OPENCLAW_HOME=$profile; $env:OPENCLAW_STATE_DIR=Join-Path $profile '.openclaw'; $env:OPENCLAW_CONFIG_PATH=Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json'
    $env:APPDATA=Join-Path $profile 'AppData/Roaming'; $env:LOCALAPPDATA=Join-Path $profile 'AppData/Local'
    $env:NPM_CONFIG_PREFIX=$prefix; $env:TEMP=$temp; $env:TMP=$temp; $env:OPENCLAW_GIT_DIR=$CandidateRoot; $env:Path="$prefix;$($saved['Path'])"
    New-Item -ItemType Directory -Force -Path $env:OPENCLAW_STATE_DIR | Out-Null
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
    @{update=@{channel='dev'};gateway=@{mode='local';bind='loopback';port=$port;auth=@{mode='token';token=[guid]::NewGuid().ToString('N')}};plugins=@{allow=@()}} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH
    $entry=Join-Path $CandidateRoot 'dist/entry.js'; $launcher=Join-Path $CandidateRoot 'openclaw.mjs'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Built candidate required.' }
    $result.entrySha256=(Get-FileHash $entry -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.launcherSha256=(Get-FileHash $launcher -Algorithm SHA256).Hash.ToLowerInvariant()
    Invoke-Diagnostic -Name 'candidate-doctor' -File $node -Arguments @($entry,'doctor','--fix','--non-interactive') -Seconds 300 -Required
    $installCommand='& npm install --global --ignore-scripts --no-audit --no-fund --loglevel error --prefix ' + (Quote-PSLiteral $prefix) + ' ' + (Quote-PSLiteral $CandidateRoot) + '; exit $LASTEXITCODE'
    Invoke-Diagnostic -Name 'npm-source-exposure' -File $engine -Arguments @('-NoProfile','-Command',$installCommand) -Seconds 300 -Required
    $shim=Join-Path $prefix 'openclaw.cmd'; $package=Join-Path $prefix 'node_modules/openclaw'
    foreach ($name in @('openclaw','openclaw.cmd','openclaw.ps1')) {
        $file=Join-Path $prefix $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { Copy-Item -LiteralPath $file -Destination (Join-Path $EvidenceRoot ($name + '.txt')) }
    }
    $link=Get-Item -LiteralPath $package
    $result.exposure=@{ fullName=$link.FullName; linkType=$link.LinkType; target=$link.Target; shimSha256=(Get-FileHash $shim -Algorithm SHA256).Hash.ToLowerInvariant() }
    Save-Diagnostic
    Invoke-Diagnostic -Name 'entry-status-stopped' -File $node -Arguments @($entry,'update','status','--json')
    Invoke-Diagnostic -Name 'launcher-status-stopped' -File $node -Arguments @($launcher,'update','status','--json')
    $shimLiteral=Quote-PSLiteral $shim
    Invoke-Diagnostic -Name 'installed-version-stopped' -File $engine -Arguments @('-NoProfile','-Command',"& $shimLiteral --version; exit `$LASTEXITCODE")
    Invoke-Diagnostic -Name 'installed-status-stopped' -File $engine -Arguments @('-NoProfile','-Command',"& $shimLiteral update status --json; exit `$LASTEXITCODE")
    $gateway=Start-Process -FilePath $node -ArgumentList @(('"'+$entry+'"'),'gateway','run','--allow-unconfigured') -WorkingDirectory $root -NoNewWindow -PassThru -RedirectStandardOutput (Join-Path $EvidenceRoot 'gateway.stdout.log') -RedirectStandardError (Join-Path $EvidenceRoot 'gateway.stderr.log')
    $deadline=[DateTime]::UtcNow.AddMinutes(3); $ready=$false
    do {
        if ($gateway.HasExited) { throw 'Gateway exited before readiness.' }
        try { $response=Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3; if ($response.StatusCode -eq 200) { $ready=$true; break } } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $ready) { throw 'Gateway readiness timed out.' }
    Invoke-Diagnostic -Name 'candidate-gateway-health' -File $node -Arguments @($entry,'gateway','health','--json') -Required
    Invoke-Diagnostic -Name 'entry-status-running' -File $node -Arguments @($entry,'update','status','--json')
    Invoke-Diagnostic -Name 'installed-status-running' -File $engine -Arguments @('-NoProfile','-Command',"& $shimLiteral update status --json; exit `$LASTEXITCODE")
    $result.result=if (@($result.commands | Where-Object { -not $_.completed -or $_.exitCode -ne 0 }).Count) { 'observed-failure' } else { 'completed' }
} catch { $failure=$_; $result.result='failed'; $result.error=$_.Exception.Message } finally {
    $cleanupErrors=@($result.unjoined | ForEach-Object { 'Unjoined diagnostic process or output: ' + $_ })
    try { if ($gateway) { try { if (-not $gateway.HasExited) { $gateway.Kill($true) }; if (-not $gateway.WaitForExit(10000)) { throw 'Gateway did not join within cleanup deadline.' } } finally { $gateway.Dispose() } } } catch { $cleanupErrors += $_.Exception.Message }
    foreach ($name in $names) {
        try { if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } else { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }; if ([Environment]::GetEnvironmentVariable($name,'Process') -cne $saved[$name]) { throw "$name restoration mismatch." } } catch { $cleanupErrors += $_.Exception.Message }
    }
    try { if ([Environment]::GetEnvironmentVariable('Path','User') -cne $userPath) { throw 'User PATH changed unexpectedly.' } } catch { $cleanupErrors += $_.Exception.Message }
    try { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }; if (Test-Path -LiteralPath $root) { throw 'Owned root survived cleanup.' } } catch { $cleanupErrors += $_.Exception.Message }
    $result.cleanupErrors=$cleanupErrors; $result.cleanup=if ($cleanupErrors.Count) { 'failed' } else { 'restored-and-removed' }
    Save-Diagnostic
}
if ($failure) { throw $failure }
if ($result.result -ne 'completed' -or $result.cleanup -ne 'restored-and-removed') { throw 'Diagnostic observed failure; inspect retained checkpoints. No acceptance is claimed.' }

exit 0
