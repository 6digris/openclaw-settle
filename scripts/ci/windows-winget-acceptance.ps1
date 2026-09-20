# PR112055 native proof: no substituted Winget, MSI metadata, Node, or Check-Node.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('healthy','stale-msi','failed-repair','unsupported-node','non-msi','all-providers-unusable')][string]$Scenario,
    [Parameter(Mandatory)][string]$CandidateRoot,
    [Parameter(Mandatory)][string]$ExpectedHead,
    [Parameter(Mandatory)][string]$ProofRoot,
    [Parameter(Mandatory)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
New-Item -ItemType Directory -Path $ProofRoot -Force | Out-Null
$proof = [ordered]@{ scenario=$Scenario; result='unqualified'; cleanup='not-started'; candidate=$ExpectedHead; commands=@(); failures=@() }
$originalPaths = @{}
$breakpoints = @()
$ownedProduct = $null
$portableOwned = $false
# Supported public-source setup lets Winget write its own portable identity.
$portableSourceIdentifier = 'Microsoft.Winget.Source_8wekyb3d8bbwe'
$portableProductCode = "OpenJS.NodeJS.LTS_$portableSourceIdentifier"
$portableRegistryPath = "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$portableProductCode"
$localManifestsEnabled = $false
$setupStarted = $false
$transcriptStarted = $false
$blockerHandle = $null
$runtime = $null
$privateNodeRoot = $null
$privateNodeOwned = $false
$privateBlockerHandle = $null
$msiLoggingState = $null
$msiLoggingRestoreFailed = $false
$started = Get-Date
$global:WingetProofTrace = [ordered]@{ install=@(); repair=@(); checkCount=0; repaired=0; fallback=0; providers=@(); totalFailure=0 }
function Assert-Proof([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$Name) {
    $output = @(& $Exe @Arguments 2>&1)
    $code = $LASTEXITCODE
    $output | Set-Content -LiteralPath (Join-Path $ProofRoot "$Name.log")
    $proof.commands += @{ name=$Name; executable=$Exe; arguments=$Arguments; exit=$code }
    return $code
}
function Get-NodeRegistration {
    # Read registration; never fabricate or edit Windows Installer records.
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path $root) {
            Get-ChildItem $root | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Node.js' } |
                Select-Object PSPath, PSChildName, DisplayName, DisplayVersion, InstallLocation, WindowsInstaller, UninstallString
        }
    }
}
function Remove-OwnedMsi([string]$Product, [string]$Label) {
    Assert-Proof ($Product -match '^\{[0-9A-Fa-f-]{36}\}$') 'Invalid MSI ProductCode.'
    # msiexec is a GUI executable: direct invocation can return before MSI exits.
    # Wait for the real process tree and read its exit code, never stale LASTEXITCODE.
    $exe = "$env:WINDIR\System32\msiexec.exe"
    $log = Join-Path $ProofRoot "$Label-msi.log"
    $arguments = @('/x',$Product,'/qn','/norestart','/l*v',('"{0}"' -f $log))
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru
    $code = $process.ExitCode
    $proof.commands += @{ name=$Label; executable=$exe; arguments=$arguments; exit=$code; processId=$process.Id; waited=$true }
    $process.Dispose()
    Assert-Proof ($code -in @(0,1605,3010)) "MSI uninstall failed: $code."
    Assert-Proof (@(Get-NodeRegistration | Where-Object PSChildName -eq $Product).Count -eq 0) 'MSI registration survived uninstall.'
}
function Enable-MsiRepairDiagnostics {
    # Supported Windows Installer logging policy, scoped to this disposable VM.
    # It does not change ProductCode/source registration, repair arguments or results.
    $keyPath = 'SOFTWARE\Policies\Microsoft\Windows\Installer'
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($keyPath,$true)
    $created = $null -eq $key
    if ($created) { $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey($keyPath) }
    try {
        $present = $key.GetValueNames() -contains 'Logging'
        $script:msiLoggingState = @{ path=$keyPath; created=$created; present=$present; value=$null; kind=$null }
        if ($present) {
            $script:msiLoggingState.value = $key.GetValue('Logging',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $script:msiLoggingState.kind = $key.GetValueKind('Logging')
        }
        $proof.msiDiagnostics = @{ policy='voicewarmupx'; enabledAt=(Get-Date).ToString('o'); logs=@(); restoration='pending' }
        $key.SetValue('Logging','voicewarmupx',[Microsoft.Win32.RegistryValueKind]::String)
    } finally { $key.Dispose() }
}
function Save-MsiRepairDiagnostics {
    $destination = Join-Path $ProofRoot 'msi-repair-diagnostics'
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    $roots = @($env:TEMP,(Join-Path $env:WINDIR 'Temp')) | Sort-Object -Unique
    $index = 0
    foreach ($root in $roots) {
        $index++
        foreach ($log in @(Get-ChildItem -LiteralPath $root -Filter 'MSI*.log' -File | Where-Object { $_.LastWriteTime -ge $started })) {
            $name = "$index-$($log.Name)"
            Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $destination $name)
            $proof.msiDiagnostics.logs += @{ source=$log.FullName; file=$name; sha256=(Get-FileHash (Join-Path $destination $name)).Hash }
        }
    }
    Assert-Proof ($proof.msiDiagnostics.logs.Count -gt 0) 'Windows Installer produced no diagnostic log for this native repair.'
}
function Restore-MsiRepairDiagnostics {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($msiLoggingState.path,$true)
    Assert-Proof ($null -ne $key) 'Task MSI logging policy key disappeared.'
    try {
        if ($msiLoggingState.present) {
            $key.SetValue('Logging',$msiLoggingState.value,$msiLoggingState.kind)
            Assert-Proof (($key.GetValueKind('Logging') -eq $msiLoggingState.kind) -and ((ConvertTo-Json -Compress -InputObject $key.GetValue('Logging',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) -ceq (ConvertTo-Json -Compress -InputObject $msiLoggingState.value))) 'MSI logging policy restoration differs.'
        } else {
            $key.DeleteValue('Logging',$false)
            Assert-Proof (-not ($key.GetValueNames() -contains 'Logging')) 'Task MSI logging policy survived cleanup.'
        }
        $empty = $key.ValueCount -eq 0 -and $key.SubKeyCount -eq 0
    } finally { $key.Dispose() }
    if ($msiLoggingState.created -and $empty) { [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKey($msiLoggingState.path,$false) }
    $proof.msiDiagnostics.restoration = 'verified'
}
function Get-RuntimeFacts([string]$Path, [string]$Name) {
    $js = @'
const out={version:process.version,execPath:process.execPath};
let db;
try {
 const {DatabaseSync}=require('node:sqlite'); db=new DatabaseSync(':memory:');
 out.sqlite=db.prepare('select sqlite_version() as v').get().v;
 const value='a\u0000b\u0000',bytes=Buffer.from(value),json=JSON.stringify({value});
 db.exec('create table p(t TEXT,b BLOB,j TEXT)'); db.prepare('insert into p values(?,?,?)').run(value,bytes,json);
 const row=db.prepare('select * from p').get();
 out.text=row.t===value; out.blob=Buffer.from(row.b).equals(bytes); out.json=JSON.parse(row.j).value===value;
} catch(e) {out.error=String(e)} finally {db?.close()}
console.log(JSON.stringify(out));
'@
    $output = @($js | & $Path - 2>$null)
    Assert-Proof ($LASTEXITCODE -eq 0) 'Authentic Node probe failed to execute.'
    $facts = ($output -join "`n") | ConvertFrom-Json
    $facts | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $ProofRoot "$Name.json")
    return $facts
}
try {
    Assert-Proof ($env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and $env:RUNNER_OS -eq 'Windows') 'Only a fresh disposable GitHub-hosted Windows VM is authorized.'
    Assert-Proof ($ExpectedHead -ceq 'dac01337bab5251fec2726f41ec4b199862e9321') 'Unexpected candidate.'
    Assert-Proof (-not (Test-Path -LiteralPath $WorkRoot)) 'Owned staging already exists.'
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $proof.host = @{ administrator=$admin; interactive=[Environment]::UserInteractive; sessionId=(Get-Process -Id $PID).SessionId; image=$env:ImageVersion; powershell=$PSVersionTable.PSVersion.ToString(); freeBytes=(Get-PSDrive C).Free }
    Assert-Proof $admin 'Effective administrator token is required for real MSI lifecycle.'
    # Headless execution is recorded, not relabeled as a console. Native commands
    # below must actually complete; any interactive-only requirement remains a gap.
    $proof.host.storage = @()
    $destinations = @($CandidateRoot,$ProofRoot,$WorkRoot,$env:ProgramFiles,$env:TEMP)
    $driveNames = @($destinations | ForEach-Object { (Split-Path -Path $_ -Qualifier).TrimEnd(':') } | Sort-Object -Unique)
    foreach ($driveName in $driveNames) {
        $disk = Get-PSDrive -Name $driveName
        $proof.host.storage += @{ drive=$driveName; root=$disk.Root; freeBytes=$disk.Free }
        Assert-Proof ($disk.Free -ge 8GB) "Insufficient measured capacity on destination drive $driveName."
    }
    $resolvedHead = (& git -C $CandidateRoot rev-parse HEAD).Trim()
    Assert-Proof ($LASTEXITCODE -eq 0 -and $resolvedHead -ceq $ExpectedHead) 'Candidate checkout mismatch.'
    $installer = Join-Path $CandidateRoot 'scripts/install.ps1'
    $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    $proof.installerSha256 = $hash
    Assert-Proof ($hash -ceq '87406a49babeff0c18ff6b0a97c0428c87265baee5b16017e91aadef42e4a1c3') 'Installer bytes differ from reviewed candidate.'
    New-Item -ItemType Directory -Path $WorkRoot | Out-Null
    $setupStarted = $true
    Start-Transcript -Path (Join-Path $ProofRoot 'transcript.log') | Out-Null
    $transcriptStarted = $true
    foreach ($scope in @('Machine','User','Process')) { $originalPaths[$scope] = [Environment]::GetEnvironmentVariable('Path',$scope) }
    # The image is disposable. Remove its enumerated MSI Node baseline using MSI,
    # not hand-written registry state; never do this on a paired/persistent host.
    $baseline = @(Get-NodeRegistration)
    $proof.imageNodeBaseline = $baseline
    foreach ($entry in $baseline) {
        Assert-Proof ($entry.WindowsInstaller -eq 1) 'Unexpected non-MSI image Node; baseline requires host-owner inspection.'
        Remove-OwnedMsi $entry.PSChildName 'remove-image-node'
    }
    foreach ($scope in @('Machine','User','Process')) {
        # Keep the native fixture's fallback ownership bounded to private Node.
        # Optional package managers are absent from this fixture's PATH; their
        # guarded product paths remain covered by focused source regressions.
        $clean = @($originalPaths[$scope] -split ';' | Where-Object {
            $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) -and
            -not (Test-Path -LiteralPath (Join-Path $_ 'choco.exe')) -and
            -not (Test-Path -LiteralPath (Join-Path $_ 'scoop.ps1')) -and
            -not (Test-Path -LiteralPath (Join-Path $_ 'scoop.cmd'))
        }) -join ';'
        [Environment]::SetEnvironmentVariable('Path',$clean,$scope)
    }
    Assert-Proof (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) 'Foreign Node is still discoverable.'
    Assert-Proof (-not (Get-Command choco,scoop -ErrorAction SilentlyContinue)) 'Optional provider remains discoverable outside the private-fallback fixture.'
    if (-not (Get-Command winget -CommandType Application -ErrorAction SilentlyContinue)) {
        Install-Module Microsoft.WinGet.Client -Repository PSGallery -Scope CurrentUser -Force
        Import-Module Microsoft.WinGet.Client
        Repair-WinGetPackageManager -AllUsers
    }
    $winget = (Get-Command winget -CommandType Application -ErrorAction Stop).Source
    $wingetVersion = @(& $winget --version)
    Assert-Proof ($LASTEXITCODE -eq 0) 'Winget alias failed to execute.'
    # The WindowsApps command is an App Execution Alias, not a readable PE file.
    # Keep invoking that command; fingerprint its current user's registered package.
    $packages = @(Get-AppxPackage -Name Microsoft.DesktopAppInstaller)
    Assert-Proof ($packages.Count -eq 1) 'Expected one registered DesktopAppInstaller package.'
    $wingetPayload = Join-Path $packages[0].InstallLocation 'winget.exe'
    $payloadVersion = @(& $wingetPayload --version)
    Assert-Proof ($LASTEXITCODE -eq 0 -and ($payloadVersion -join "`n") -ceq ($wingetVersion -join "`n")) 'Registered Winget payload version differs from command.'
    $proof.winget = @{ path=$winget; version=($wingetVersion -join "`n").Trim(); packageFullName=$packages[0].PackageFullName; payloadPath=$wingetPayload; payloadSha256=(Get-FileHash -LiteralPath $wingetPayload -Algorithm SHA256).Hash; hashScope='Registered package payload; native commands retain command-resolution path' }
    Assert-Proof ((Invoke-Native $winget @('source','update','--name','winget','--disable-interactivity') 'source-update') -eq 0) 'Winget catalog refresh failed.'
    # Immutable upstream artifact contract; a moved catalog must fail stale-HRESULT
    # reproduction, not silently count a normal upgrade as repair acceptance.
    $manifestBase = 'https://raw.githubusercontent.com/microsoft/winget-pkgs/ed043bfd0afedc6652936921fbef12b96e854862/manifests/o/OpenJS/NodeJS/LTS/24.19.0'
    $manifestDirectory = Join-Path $WorkRoot 'manifest'
    New-Item -ItemType Directory -Path $manifestDirectory | Out-Null
    $manifestFiles = @('OpenJS.NodeJS.LTS.yaml','OpenJS.NodeJS.LTS.installer.yaml','OpenJS.NodeJS.LTS.locale.en-US.yaml')
    $proof.manifest = @{ base=$manifestBase; files=@(); version='24.19.0'; productCode='{89850E15-F7D6-476D-972E-F8F5215E4498}' }
    foreach ($name in $manifestFiles) {
        $destination = Join-Path $manifestDirectory $name
        Invoke-WebRequest "$manifestBase/$name" -OutFile $destination
        Copy-Item -LiteralPath $destination -Destination (Join-Path $ProofRoot $name)
        $proof.manifest.files += @{ name=$name; sha256=(Get-FileHash $destination).Hash }
    }
    # Native local-manifest installation enforces the pinned InstallerSha256,
    # instead of resolving the setup artifact from today's mutable catalog.
    # Candidate install/repair below still use their unmodified public source.
    if ($Scenario -eq 'healthy') {
        Assert-Proof ((Invoke-Native $winget @('settings','--enable','LocalManifestFiles') 'enable-local-manifests') -eq 0) 'Native local-manifest setup unavailable.'
        $localManifestsEnabled = $true
    }
    . $installer -DryRun -NoOnboard
    $DryRun = $false
    $privateNodeRoot = Get-PortableNodeRoot
    Assert-Proof (-not (Test-Path -LiteralPath $privateNodeRoot)) 'Preexisting private Node is not task-owned.'
    $privateNodeOwned = $true
    if ($Scenario -eq 'all-providers-unusable') {
        # A real filesystem obstruction refuses private runtime publication;
        # leave download, checksum, extraction and Check-Node untouched.
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $privateNodeRoot) | Out-Null
        $privateBlockerHandle = [IO.File]::Open($privateNodeRoot,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    # These read-only debugger observers preserve command resolution, arguments,
    # native HRESULTs and real Check-Node. They do not replace a function or return.
    $lines = Get-Content -LiteralPath $installer
    $installLine = @((0..($lines.Count-1)) | Where-Object { $lines[$_] -match '^            \$wingetAttempt\.ExitCode = \$LASTEXITCODE$' })
    $repairLine = @((0..($lines.Count-1)) | Where-Object { $lines[$_] -match '^            \$wingetRepairExitCode = \$LASTEXITCODE$' })
    Assert-Proof ($installLine.Count -eq 1 -and $repairLine.Count -eq 1) 'Expected exact repair observation sites.'
    $breakpoints += Set-PSBreakpoint -Script $installer -Line ($installLine[0]+2) -Action { $global:WingetProofTrace.install += $wingetAttempt.ExitCode }
    $breakpoints += Set-PSBreakpoint -Script $installer -Line ($repairLine[0]+2) -Action { $global:WingetProofTrace.repair += $wingetRepairExitCode }
    $breakpoints += Set-PSBreakpoint -Command Check-Node -Action { $global:WingetProofTrace.checkCount++ }
    # Run the exact Main prefix including its final Node recheck. Stop before
    # unrelated npm/OpenClaw installation. This is not full Main/E2E proof.
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($installer,[ref]$tokens,[ref]$parseErrors)
    Assert-Proof ($parseErrors.Count -eq 0) 'Candidate parse failed.'
    $installNode = $ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Install-Node'},$false)
    $repairSuccessSite = @($installNode.Body.FindAll({param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.Extent.Text -ceq 'Write-Host "[OK] Node.js repaired via winget" -ForegroundColor Green'},$false))
    $fallbackSite = @($installNode.Body.FindAll({param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.Extent.Text -ceq 'Install-PortableNode'},$false))
    $failureSite = @($installNode.Body.FindAll({param($a) $a -is [Management.Automation.Language.ReturnStatementAst] -and $a.Extent.Text -ceq 'return $false'},$false))
    $portableSuccessSite = @($installNode.Body.FindAll({param($a) $a -is [Management.Automation.Language.IfStatementAst] -and $a.Extent.Text -match '^if \(Check-Node\)'},$false))
    Assert-Proof ($repairSuccessSite.Count -eq 1 -and $fallbackSite.Count -eq 1 -and $failureSite.Count -eq 1 -and $portableSuccessSite.Count -eq 1) 'Expected exact repair/fallback/failure observation sites.'
    $portableReturn = @($portableSuccessSite[0].FindAll({param($a) $a -is [Management.Automation.Language.ReturnStatementAst] -and $a.Extent.Text -ceq 'return $true'},$false))
    Assert-Proof ($portableReturn.Count -eq 1) 'Expected one validated portable success return.'
    $breakpoints += Set-PSBreakpoint -Script $installer -Line $repairSuccessSite[0].Extent.StartLineNumber -Action { $global:WingetProofTrace.repaired++ }
    $breakpoints += Set-PSBreakpoint -Script $installer -Line $fallbackSite[0].Extent.StartLineNumber -Action { $global:WingetProofTrace.fallback++ }
    $breakpoints += Set-PSBreakpoint -Script $installer -Line $portableReturn[0].Extent.StartLineNumber -Action { $global:WingetProofTrace.providers += 'private-node' }
    $breakpoints += Set-PSBreakpoint -Script $installer -Line $failureSite[0].Extent.StartLineNumber -Action { $global:WingetProofTrace.totalFailure++ }

    $main = $ast.Find({param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq 'Main'},$false)
    $boundary = @($main.Body.EndBlock.Statements | Where-Object { $_.Extent.Text -ceq '$finalGitDir = $null' })
    Assert-Proof ($boundary.Count -eq 1) 'Exact Main Node-gate boundary not found.'
    $source = Get-Content $installer -Raw
    $prefix = $source.Substring($main.Body.Extent.StartOffset+1,$boundary[0].Extent.StartOffset-$main.Body.Extent.StartOffset-1)
    $prefix | Set-Content (Join-Path $ProofRoot 'main-node-gate.ps1')
    $proof.mainGateScope = 'Exact Main prefix through final Node recheck; no npm/install/onboarding E2E claim'
    if ($Scenario -eq 'unsupported-node') {
        $version = '22.23.2'
        $file = "node-v$version-win-x64.zip"
        Invoke-WebRequest "https://nodejs.org/dist/v$version/$file" -OutFile (Join-Path $WorkRoot $file)
        Invoke-WebRequest "https://nodejs.org/dist/v$version/SHASUMS256.txt" -OutFile (Join-Path $ProofRoot 'unsupported-SHASUMS256.txt')
        $sum = @(Get-Content (Join-Path $ProofRoot 'unsupported-SHASUMS256.txt') | Where-Object { $_ -match ('\s+'+[regex]::Escape($file)+'$') })
        Assert-Proof ($sum.Count -eq 1 -and (Get-FileHash (Join-Path $WorkRoot $file)).Hash -eq ($sum[0] -split '\s+')[0]) 'Unsupported official Node archive hash mismatch.'
        Expand-Archive (Join-Path $WorkRoot $file) -DestinationPath $WorkRoot
        $runtime = Join-Path $WorkRoot "node-v$version-win-x64/node.exe"
        $proof.unsupported = Get-RuntimeFacts $runtime 'unsupported-runtime'
        Assert-Proof (-not (Check-Node -NodePath $runtime)) 'Unsupported real Node was accepted.'
        Assert-Proof ($global:WingetProofTrace.install.Count -eq 0 -and $global:WingetProofTrace.repair.Count -eq 0) 'Unsupported-version gate unexpectedly installed/repaired.'
    } else {
        $type = if ($Scenario -eq 'non-msi') { 'zip' } else { 'wix' }
        $scope = if ($Scenario -eq 'non-msi') { 'user' } else { 'machine' }
        $arguments = @('install','--manifest',$manifestDirectory,'--architecture','x64','--installer-type',$type,'--scope',$scope,'--accept-package-agreements','--accept-source-agreements','--disable-interactivity','--silent')
        if ($Scenario -eq 'non-msi') {
            Assert-Proof (-not (Test-Path -LiteralPath $portableRegistryPath)) 'Preexisting public-source portable registration is not task-owned.'
            Assert-Proof ((Invoke-Native $winget @('source','export','--name','winget') 'portable-source') -eq 0) 'Could not inspect the public Winget source.'
            $publicSource = Get-Content (Join-Path $ProofRoot 'portable-source.log') -Raw | ConvertFrom-Json
            Assert-Proof ($publicSource.Identifier -ceq $portableSourceIdentifier -and $publicSource.Arg -ceq 'https://cdn.winget.microsoft.com/cache') 'Unexpected public Winget source identity.'
            # Local --manifest setup writes *DefaultSource and cannot qualify this
            # candidate's unchanged --source winget lookup. Use the catalog flow.
            # Refuse catalog drift; keep the pinned upstream ZIP URL and SHA256.
            $selection = @('--id','OpenJS.NodeJS.LTS','--exact','--source','winget','--version',$proof.manifest.version,'--architecture','x64','--installer-type','zip','--scope','user','--accept-source-agreements','--disable-interactivity')
            Assert-Proof ((Invoke-Native $winget (@('show') + $selection) 'portable-catalog-installer') -eq 0) 'Pinned public portable installer is unavailable.'
            $catalogInstaller = Get-Content (Join-Path $ProofRoot 'portable-catalog-installer.log') -Raw
            Assert-Proof ($catalogInstaller -match [regex]::Escape('https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip') -and $catalogInstaller -match '57F71AB3652E797D84ACDDC79C81CC9FF1C6DDB2A1974CDB83F00FEE9BFF4C73') 'Public portable installer differs from pinned artifact.'
            $proof.portableSetup = @{ source=$publicSource; version=$proof.manifest.version; installerSha256='57F71AB3652E797D84ACDDC79C81CC9FF1C6DDB2A1974CDB83F00FEE9BFF4C73'; qualification='Native public-source registration; no metadata rewritten' }
            $portableOwned = $true
            $arguments = @('install') + $selection + @('--accept-package-agreements','--silent','--location',(Join-Path $WorkRoot 'portable'))
        } else { $ownedProduct = $proof.manifest.productCode }
        if ($Scenario -in @('stale-msi','failed-repair','all-providers-unusable')) {
            # Winget deletes its downloaded MSI after install. Native repair then
            # fails with 1706/1603 when missing files need that source (run35471472032).
            # Establish a genuinely repairable product with the vendor installer;
            # Windows Installer writes all registration and source metadata itself.
            # Keep the exact media until native uninstall, then owned-staging removes it.
            $msiPath = Join-Path $WorkRoot 'node-v24.19.0-x64.msi'
            $msiSha256 = 'F0F66C2A80C08A30A5AB5179EE9EA9E45F9B46289436A8CC87FF833B852DB351'
            Invoke-WebRequest 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-x64.msi' -OutFile $msiPath
            Assert-Proof ((Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash -ceq $msiSha256) 'Vendor MSI differs from pinned manifest.'
            Assert-Proof ((Get-AuthenticodeSignature -LiteralPath $msiPath).Status -eq 'Valid') 'Vendor MSI signature is invalid.'
            $msiExe = "$env:WINDIR\System32\msiexec.exe"
            $msiLog = Join-Path $ProofRoot 'setup-retained-msi.log'
            $msiArguments = @('/i',('"{0}"' -f $msiPath),'/qn','/norestart','/l*v',('"{0}"' -f $msiLog))
            $process = Start-Process -FilePath $msiExe -ArgumentList $msiArguments -Wait -PassThru
            $setupExit = $process.ExitCode
            $proof.commands += @{ name='setup-retained-msi'; executable=$msiExe; arguments=$msiArguments; exit=$setupExit; processId=$process.Id; waited=$true }
            $process.Dispose()
            Assert-Proof ($setupExit -in @(0,3010)) 'Native retained-source MSI setup failed.'
            $proof.msiSetup = @{ method='vendor-msiexec'; source=$msiPath; sha256=$msiSha256; scope='Repairable missing executable with original source available; not missing-media recovery' }
            Assert-Proof ((Invoke-Native $winget @('list','--id','OpenJS.NodeJS.LTS','--exact','--source','winget','--scope','machine','--accept-source-agreements','--disable-interactivity') 'msi-catalog-correlation') -eq 0) 'Vendor MSI is not correlated to the public Winget source.'
        } else {
            Assert-Proof ((Invoke-Native $winget $arguments 'setup-node') -eq 0) 'Exact native package setup failed.'
        }
        Refresh-ProcessPath
        Add-InstalledNodeToProcessPath | Out-Null
        $proof.registration = @(Get-NodeRegistration)
        if ($Scenario -eq 'non-msi') {
            Assert-Proof (@($proof.registration | Where-Object WindowsInstaller -eq 1).Count -eq 0) 'Portable control unexpectedly has MSI registration.'
            Assert-Proof (Test-Path -LiteralPath $portableRegistryPath) 'Native public-source portable registration is absent.'
            $proof.portableRegistration = Get-ItemProperty -LiteralPath $portableRegistryPath | Select-Object PSPath, PSChildName, DisplayName, DisplayVersion, InstallLocation, UninstallString, WinGetPackageIdentifier, WinGetSourceIdentifier, WinGetInstallerType, WindowsInstaller
            $registration = $proof.portableRegistration
            Assert-Proof ($registration.WinGetPackageIdentifier -ceq 'OpenJS.NodeJS.LTS' -and $registration.WinGetSourceIdentifier -ceq $portableSourceIdentifier -and $registration.WinGetInstallerType -ceq 'portable' -and $registration.WindowsInstaller -ne 1 -and $registration.DisplayVersion -ceq $proof.manifest.version) 'Real portable registration does not match the pinned public package.'
            # Verify public-source discovery in addition to the exact native registry identity.
            $correlationExit = Invoke-Native $winget @('list','--id','OpenJS.NodeJS.LTS','--exact','--source','winget','--scope','user','--accept-source-agreements','--disable-interactivity','--verbose-logs') 'portable-catalog-correlation'
            if ($correlationExit -ne 0) {
                # Read-only diagnostics distinguish source correlation from scope
                # filtering and malformed native ARP values. No fallback is acceptance.
                $proof.portableRegistrationValues = @()
                $key = Get-Item -LiteralPath $portableRegistryPath
                try {
                    foreach ($name in $key.GetValueNames()) {
                        $proof.portableRegistrationValues += @{ name=$name; kind=$key.GetValueKind($name).ToString(); value=$key.GetValue($name) }
                    }
                } finally { $key.Dispose() }
                Invoke-Native $winget @('list','--id','OpenJS.NodeJS.LTS','--exact','--source','winget','--accept-source-agreements','--disable-interactivity','--verbose-logs') 'portable-correlation-without-scope' | Out-Null
                Invoke-Native $winget @('list','--name','Node.js (LTS)','--exact','--source','winget','--scope','user','--accept-source-agreements','--disable-interactivity','--verbose-logs') 'portable-correlation-by-name' | Out-Null
            }
            Assert-Proof ($correlationExit -eq 0) 'Portable registration is not correlated to the public source.'
            $executables = @(Get-ChildItem (Join-Path $WorkRoot 'portable') -Filter node.exe -Recurse -File)
            Assert-Proof ($executables.Count -eq 1) 'Portable install location is ambiguous.'
            $runtime = $executables[0].FullName
        } else {
            Assert-Proof (@($proof.registration | Where-Object { $_.PSChildName -eq $ownedProduct -and $_.WindowsInstaller -eq 1 -and $_.DisplayVersion -eq '24.19.0' }).Count -eq 1) 'Real MSI metadata differs from pinned manifest.'
            $runtime = Join-Path $env:ProgramFiles 'nodejs/node.exe'
            Assert-Proof ((Get-AuthenticodeSignature $runtime).Status -eq 'Valid') 'Installed Node signature is invalid.'
        }
        $proof.before = Get-RuntimeFacts $runtime 'runtime-before'
        Assert-Proof (Check-Node -NodePath $runtime) 'Pinned native package fails existing runtime gate.'
        $proof.nodeBeforeSha256 = (Get-FileHash $runtime).Hash
        if ($Scenario -ne 'healthy') {
            Move-Item -LiteralPath $runtime -Destination (Join-Path $WorkRoot 'original-node.exe')
            if ($Scenario -in @('failed-repair','all-providers-unusable')) {
                # Real filesystem fault: MSI cannot replace a directory at the
                # executable path. Keep a held child to prevent recursive removal.
                New-Item -ItemType Directory -Path $runtime | Out-Null
                $blockerHandle = [IO.File]::Open((Join-Path $runtime 'owned-blocker'),[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
            }
            Assert-Proof (-not (Check-Node)) 'Stale setup still discovers a usable foreign runtime.'
        }
        $global:WingetProofTrace.install=@(); $global:WingetProofTrace.repair=@(); $global:WingetProofTrace.checkCount=0; $global:WingetProofTrace.repaired=0; $global:WingetProofTrace.fallback=0; $global:WingetProofTrace.providers=@(); $global:WingetProofTrace.totalFailure=0
        $global:WingetProofMainReached = $false
        $script:InstallExitCode = 0
        $gate = [scriptblock]::Create($prefix + "`n`$global:WingetProofMainReached = `$true")
        if ($Scenario -in @('stale-msi','failed-repair','all-providers-unusable')) {
            Assert-Proof ((Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash -ceq $msiSha256) 'Retained MSI source changed before repair.'
            Enable-MsiRepairDiagnostics
        }
        & $gate
        $proof.mainReached = $global:WingetProofMainReached
        $proof.registrationAfterGate = @(Get-NodeRegistration)
        $proof.installExit = $script:InstallExitCode
        $proof.trace = $global:WingetProofTrace
        if ($Scenario -eq 'healthy') {
            Assert-Proof ($proof.mainReached -and $proof.trace.install.Count -eq 0 -and $proof.trace.repair.Count -eq 0 -and $proof.trace.fallback -eq 0 -and $proof.trace.repaired -eq 0 -and $proof.trace.totalFailure -eq 0) 'Healthy Main gate invoked installation/repair or failed.'
            $proof.outcome = 'healthy-noop'
        } else {
            Assert-Proof ($proof.trace.install.Count -eq 1 -and $proof.trace.install[0] -eq -1978335189) 'Native install did not reproduce stale HRESULT 0x8A15002B; not repair acceptance.'
            Assert-Proof ($proof.trace.repair.Count -eq 1) 'Expected exactly one real Winget repair.'
            if ($Scenario -eq 'stale-msi') {
                Assert-Proof ($proof.trace.repair[0] -eq 0 -and $proof.mainReached -and $proof.installExit -eq 0) 'Real MSI repair or final Main Node gate failed.'
                Assert-Proof ($proof.trace.repaired -eq 1 -and $proof.trace.fallback -eq 0 -and $proof.trace.totalFailure -eq 0) 'Repair success was replaced by fallback or total failure.'
                $proof.outcome = 'winget-repaired'
                Assert-Proof ($proof.trace.checkCount -ge 4) 'Final Main Node recheck not observed.'
                $proof.after = Get-RuntimeFacts $runtime 'runtime-after'
                Assert-Proof ((Check-Node) -and $proof.after.text -and $proof.after.blob -and $proof.after.json) 'Repaired native Node/SQLite checks failed.'
            } else {
                Assert-Proof ($proof.trace.repair[0] -ne 0 -and $proof.trace.repaired -eq 0) 'Failed/unsupported real repair was reported as repaired.'
                Assert-Proof ($proof.trace.fallback -eq 1) 'Failed repair did not reach the guarded private fallback.'
                if ($Scenario -ne 'all-providers-unusable') {
                    Assert-Proof $proof.mainReached 'Expected genuine validated fallback after failed/unsupported repair.'
                    Assert-Proof ($proof.installExit -eq 0 -and $proof.trace.providers.Count -eq 1 -and $proof.trace.providers[0] -ceq 'private-node' -and $proof.trace.totalFailure -eq 0) 'Main advanced without validated fallback success.'
                    $fallbackRuntime = (Get-Command node -CommandType Application -ErrorAction Stop).Source
                    Assert-Proof ([IO.Path]::GetFullPath($fallbackRuntime) -ieq [IO.Path]::GetFullPath((Join-Path $privateNodeRoot 'node.exe'))) 'Fallback runtime is outside the task-owned private installation.'
                    $proof.after = Get-RuntimeFacts $fallbackRuntime 'runtime-after-fallback'
                    Assert-Proof ((Check-Node) -and $proof.after.text -and $proof.after.blob -and $proof.after.json) 'Fallback runtime failed real Node/SQLite validation.'
                    $proof.outcome = 'validated-private-fallback'
                } else {
                    Assert-Proof (-not $proof.mainReached -and $proof.installExit -ne 0 -and $proof.trace.providers.Count -eq 0 -and $proof.trace.totalFailure -eq 1 -and -not (Check-Node)) 'Total provider failure did not stop Main truthfully.'
                    Assert-Proof ($null -ne $privateBlockerHandle -and -not $privateBlockerHandle.SafeFileHandle.IsClosed -and (Test-Path -LiteralPath $privateNodeRoot -PathType Leaf)) 'Total-failure filesystem obstruction did not remain active.'
                    $proof.outcome = 'all-providers-unusable'
                }
            }
        }
    }
    $proof.result = 'passed'
} catch {
    $proof.failures += $_.Exception.Message
    $proof.result = 'failed-or-unqualified'
} finally {
    # Capture repair logs before teardown emits unrelated MSI events. Always restore
    # the exact preexisting diagnostic policy even if capture or native repair fails.
    if ($msiLoggingState) {
        try { Save-MsiRepairDiagnostics } catch {
            $proof.failures += "MSI diagnostic collection: $($_.Exception.Message)"
            $proof.result = 'failed-or-unqualified'
        }
        try { Restore-MsiRepairDiagnostics } catch {
            $msiLoggingRestoreFailed = $true
            $proof.failures += "MSI diagnostic policy cleanup: $($_.Exception.Message)"
            $proof.result = 'failed-or-unqualified'
        }
    }
    if ($breakpoints.Count) { $breakpoints | Remove-PSBreakpoint }
    if ($blockerHandle) { $blockerHandle.Dispose() }
    if ($privateBlockerHandle) { $privateBlockerHandle.Dispose() }
    # Independent cleanup steps: a failed native uninstall must not skip policy
    # restoration or other task-owned removals. Never turn failure into acceptance.
    $cleanupFailed = $false
    $cleanupSteps = @(
        @{ name='filesystem-blocker'; action={
            if ($runtime -and (Test-Path -LiteralPath $runtime -PathType Container) -and $Scenario -in @('failed-repair','all-providers-unusable')) { Remove-Item -LiteralPath $runtime -Recurse -Force }
        } },
        @{ name='owned-msi'; action={
            if ($ownedProduct) { Remove-OwnedMsi $ownedProduct 'cleanup-owned-msi' }
            if ($portableOwned) {
                # The observed public-source fallback installed the same pinned MSI.
                # Remove only that exact product; preserve unexpected identities.
                foreach ($entry in @(Get-NodeRegistration | Where-Object WindowsInstaller -eq 1)) {
                    Assert-Proof ($entry.PSChildName -eq $proof.manifest.productCode -and $entry.DisplayVersion -eq $proof.manifest.version) 'Unexpected MSI after portable control; cannot claim owned teardown.'
                    Remove-OwnedMsi $entry.PSChildName 'cleanup-portable-fallback-msi'
                }
            }
        } },
        @{ name='owned-portable'; action={
            if ($portableOwned -and (Test-Path -LiteralPath $portableRegistryPath)) {
                # Target the product code written by the supported catalog install;
                # do not fall back to another package/source or rewrite metadata.
                $code = Invoke-Native $winget @('uninstall','--product-code',$portableProductCode,'--exact','--source','winget','--scope','user','--silent','--accept-source-agreements','--disable-interactivity','--verbose-logs') 'cleanup-owned-portable'
                Assert-Proof ($code -eq 0) 'Portable native cleanup failed.'
                Assert-Proof (-not (Test-Path -LiteralPath $portableRegistryPath)) 'Portable registration remains.'
            }
        } },
        @{ name='owned-private-node'; action={
            if ($privateNodeOwned -and (Test-Path -LiteralPath $privateNodeRoot)) { Remove-Item -LiteralPath $privateNodeRoot -Recurse -Force }
            if ($privateNodeOwned) { Assert-Proof (-not (Test-Path -LiteralPath $privateNodeRoot)) 'Task-owned private fallback survived cleanup.' }
        } },
        @{ name='local-manifest-setting'; action={
            if ($localManifestsEnabled) {
                Assert-Proof ((Invoke-Native $winget @('settings','--disable','LocalManifestFiles') 'disable-local-manifests') -eq 0) 'Could not disable task-enabled local manifests.'
            }
        } },
        @{ name='owned-staging'; action={
            if ($portableOwned) { Assert-Proof (-not (Test-Path -LiteralPath $portableRegistryPath)) 'Retain staging for failed portable unregister; host teardown remains required.' }
            if ($setupStarted -and (Test-Path -LiteralPath $WorkRoot)) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force }
            Assert-Proof (-not (Test-Path -LiteralPath $WorkRoot)) 'Task-owned staging survived cleanup.'
        } }
    )
    foreach ($step in $cleanupSteps) {
        try { & $step.action } catch {
            $cleanupFailed = $true
            $proof.failures += "$($step.name): $($_.Exception.Message)"
            $proof.result = 'failed-or-unqualified'
        }
    }
    $proof.cleanup = if ($cleanupFailed) { 'failed' } else { 'verified' }
    foreach ($scope in $originalPaths.Keys) { [Environment]::SetEnvironmentVariable('Path',$originalPaths[$scope],$scope) }
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
    # Keep only this fresh VM's diagnostic logs for native command/HRESULT audit.
    $logRoots = @((Join-Path $env:LOCALAPPDATA 'Packages/Microsoft.DesktopAppInstaller_8wekyb3d8bbwe/LocalState/DiagOutputDir'),(Join-Path $env:LOCALAPPDATA 'Microsoft/WinGet/DiagOutputDir'))
    New-Item -ItemType Directory -Force -Path (Join-Path $ProofRoot 'winget-logs') | Out-Null
    foreach ($root in $logRoots) {
        if (Test-Path $root) {
            Get-ChildItem $root -File | Where-Object { $_.LastWriteTime -ge $started } | Copy-Item -Destination (Join-Path $ProofRoot 'winget-logs')
        }
    }
    if ($msiLoggingRestoreFailed) { $proof.cleanup = 'failed'; $proof.result = 'failed-or-unqualified' }
    $proof.trace = $global:WingetProofTrace
    $proof | ConvertTo-Json -Depth 12 | Set-Content (Join-Path $ProofRoot 'result.json')
}
if ($proof.result -ne 'passed' -or $proof.cleanup -ne 'verified') { throw 'Native acceptance incomplete; inspect result.json and actual Winget/MSI logs.' }
# The workflow pwsh footer propagates LASTEXITCODE. Expected negative native
# outcomes are already asserted and recorded; only a fully passed, cleaned
# harness may return success to its caller.
exit 0
