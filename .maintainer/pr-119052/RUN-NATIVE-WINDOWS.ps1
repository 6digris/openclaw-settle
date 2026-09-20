param(
  [Parameter(Mandatory=$true)][string]$RepositoryPath,
  [Parameter(Mandatory=$true)][string]$ProofDirectory,
  [switch]$MatrixOnly
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Requires the authorized native Windows fixture.' }
$binding = Get-Content -Raw (Join-Path $PSScriptRoot 'WINDOWS-FIXTURE-BINDING.json') | ConvertFrom-Json
$expected = [string]$binding.candidateHead
if ($expected -notmatch '^[0-9a-f]{40}$') { throw 'Final integrated candidate head has not been sealed.' }
Set-Location -LiteralPath $RepositoryPath
$actual = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $expected) { throw 'Candidate HEAD mismatch.' }
& git diff --quiet HEAD --
if ($LASTEXITCODE -ne 0) { throw 'Tracked candidate source differs from its sealed commit.' }
foreach ($group in @($binding.sourceHashes, $binding.driverHashes)) {
  foreach ($entry in $group.PSObject.Properties) {
    $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $RepositoryPath $entry.Name)).Hash.ToLowerInvariant()
    if ($observed -ne $entry.Value) { throw "Candidate/driver hash mismatch: $($entry.Name)" }
  }
}
if (Test-Path -LiteralPath $ProofDirectory) { throw 'Proof directory must be new and task-owned.' }
New-Item -ItemType Directory -Path $ProofDirectory | Out-Null
$runId = 'pr119052-' + $expected.Substring(0,8) + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
foreach ($entry in $binding.packetHashes.PSObject.Properties) {
  $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $PSScriptRoot $entry.Name)).Hash.ToLowerInvariant()
  if ($observed -ne $entry.Value) { throw "Packet driver hash mismatch: $($entry.Name)" }
}
if (-not $MatrixOnly) {
$env:CI_WINDOWS_SCHTASKS_INTEGRATION = '1'
$env:CI_WINDOWS_SCHTASKS_HEAD = $expected
$env:CI_WINDOWS_SCHTASKS_TEST_ID = $runId
$env:CI_WINDOWS_SCHTASKS_ROOT = Join-Path $ProofDirectory 'fixture'
$env:CI_WINDOWS_SCHTASKS_PROOF_PATH = Join-Path $ProofDirectory 'lifecycle.json'
& node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts src/daemon/schtasks.integration.e2e.test.ts --maxWorkers=1
if ($LASTEXITCODE -ne 0) { throw 'Native baseline lifecycle failed; retain diagnostics and own-resource recovery state.' }
$proof = Get-Content -Raw $env:CI_WINDOWS_SCHTASKS_PROOF_PATH | ConvertFrom-Json
if ($proof.result -ne 'pass' -or $proof.head -ne $expected) { throw 'Native proof does not bind the exact candidate.' }
}
$matrixRoot = Join-Path $ProofDirectory 'activation-matrix'
& node --import ./scripts/tsx.mjs (Join-Path $PSScriptRoot 'RUN-ACTIVATION-MATRIX.mjs') $RepositoryPath $matrixRoot $expected
if ($LASTEXITCODE -ne 0) { throw 'Native activation matrix failed or remains incomplete; preserve diagnostics and exact owned resources.' }
$matrix = Get-Content -Raw (Join-Path $matrixRoot 'matrix.json') | ConvertFrom-Json
if ($matrix.status -ne 'PASS' -or $matrix.head -ne $expected) { throw 'Native matrix does not bind the exact candidate.' }
if (@($matrix.cells | Where-Object { $_.status -ne 'PASS' }).Count -ne 0) { throw 'Native matrix has unrun or failed cells.' }
Write-Output 'Requested native driver completed. Inspect cell observations and cleanup; MatrixOnly does not qualify the baseline lifecycle.'
