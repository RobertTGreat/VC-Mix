$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'build/installer-test'))
$installDirectory = Join-Path $testRoot 'plugins/vc-mix'
$legacyDirectory = Join-Path $testRoot 'plugins/discord-voice/bin/64bit'
$registryPath = 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/VCMixInstallerTest'
if (!$testRoot.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'Installer tests must stay inside the project.'
}

function Run-TestInstaller {
  param([string]$Executable, [string[]]$Arguments, [int]$ExpectedExitCode = 0)
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  if (!$process.WaitForExit(60000)) { Stop-Process -Id $process.Id; throw 'Installer test timed out.' }
  if ($process.ExitCode -ne $ExpectedExitCode) { throw "Installer exited with code $($process.ExitCode); expected $ExpectedExitCode." }
}

function Get-TestFileHash {
  param([string]$Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try { return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)) }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

if (Test-Path -LiteralPath "$installDirectory/Uninstall.exe") {
  Run-TestInstaller -Executable "$installDirectory/Uninstall.exe" -Arguments @('/S')
  for ($attempt = 0; $attempt -lt 100 -and (Test-Path -LiteralPath $installDirectory); $attempt++) { Start-Sleep -Milliseconds 100 }
  if (Test-Path -LiteralPath $installDirectory) { throw 'Could not reset the isolated installation.' }
}

New-Item -ItemType Directory -Force -Path $legacyDirectory | Out-Null
$sentinel = Join-Path $testRoot 'settings-preserved.txt'
[System.IO.File]::WriteAllText($sentinel, 'Settings outside the plugin directory must survive uninstall.')
[System.IO.File]::WriteAllText((Join-Path $legacyDirectory 'discord-voice.dll'), 'Legacy plugin fixture')
& "$PSScriptRoot/build-installer.ps1" -TestBuild
$installer = Join-Path $testRoot 'vc-mix-test-setup.exe'
Run-TestInstaller -Executable $installer -Arguments @('/S')

foreach ($relativePath in @('bin/64bit/vc-mix.dll', 'data/helper/node.exe', 'data/helper/src/obs/helper.js', 'Uninstall.exe', 'install.ini')) {
  if (!(Test-Path -LiteralPath (Join-Path $installDirectory $relativePath))) { throw "Installed file is missing: $relativePath" }
}
if (Test-Path -LiteralPath "$legacyDirectory/discord-voice.dll") { throw 'The previous plugin was not disabled.' }
if (!(Test-Path -LiteralPath "$legacyDirectory/discord-voice.dll.disabled-vc-mix")) { throw 'The previous plugin backup is missing.' }
if (!(Test-Path -LiteralPath $registryPath)) { throw 'Windows uninstall registration is missing.' }
$expectedHash = Get-TestFileHash -Path "$projectRoot/dist/vc-mix/bin/64bit/vc-mix.dll"
if ((Get-TestFileHash -Path "$installDirectory/bin/64bit/vc-mix.dll") -ne $expectedHash) { throw 'Installer payload differs from the tested plugin.' }
Write-Output 'PASS: Installation, complete runtime payload, previous-module retirement and uninstall registration.'

Run-TestInstaller -Executable $installer -Arguments @('/S', "/D=$installDirectory")
if ((Get-TestFileHash -Path "$installDirectory/bin/64bit/vc-mix.dll") -ne $expectedHash) { throw 'Upgrade changed the plugin unexpectedly.' }
Write-Output 'PASS: Reinstall upgrades the existing installation.'

$lockedLibrary = [System.IO.File]::Open("$installDirectory/bin/64bit/vc-mix.dll", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try { Run-TestInstaller -Executable $installer -Arguments @('/S', "/D=$installDirectory") -ExpectedExitCode 32 }
finally { $lockedLibrary.Dispose() }
Run-TestInstaller -Executable $installer -Arguments @('/S', "/D=$testRoot/plugins/invalid-target") -ExpectedExitCode 123
if (Test-Path -LiteralPath "$testRoot/plugins/invalid-target") { throw 'Installer wrote to an invalid destination.' }
Write-Output 'PASS: In-use plugin binaries and invalid destinations are rejected before installation.'

$decoderProbe = @'
import assert from 'node:assert/strict';
import { ParticipantAudio } from './src/audio/ParticipantAudio.js';
const peaks = [];
const participant = new ParticipantAudio({ write(audio) {
  let peak = 0;
  for (let offset = 0; offset < audio.length; offset += 2) peak = Math.max(peak, Math.abs(audio.readInt16LE(offset)));
  peaks.push(peak);
}, close() {} }, () => {});
participant.receive(Buffer.from('680be4c136ecc58d8c4948426cd0', 'hex'));
participant.receive(Buffer.from('f8fffe', 'hex'));
participant.close();
assert.deepEqual(peaks, [2, 0]);
console.log('PASS: Installed native Opus decoder and silence-transition regression.');
'@
Push-Location -LiteralPath "$installDirectory/data/helper"
try {
  & ./node.exe --input-type=module -e $decoderProbe
  if ($LASTEXITCODE -ne 0) { throw 'The installed receiver could not load its native decoder.' }
} finally { Pop-Location }

Run-TestInstaller -Executable "$installDirectory/Uninstall.exe" -Arguments @('/S')
for ($attempt = 0; $attempt -lt 100 -and (Test-Path -LiteralPath $installDirectory); $attempt++) { Start-Sleep -Milliseconds 100 }
if (Test-Path -LiteralPath "$installDirectory/bin") { throw 'Uninstall left the plugin binary behind.' }
if (Test-Path -LiteralPath "$installDirectory/data") { throw 'Uninstall left the receiver behind.' }
if (Test-Path -LiteralPath $registryPath) { throw 'Uninstall left Windows registration behind.' }
if (!(Test-Path -LiteralPath $sentinel)) { throw 'Uninstall removed data outside the plugin folder.' }
Write-Output 'PASS: Uninstall removes the plugin and runtime while preserving data outside its directory.'
