param(
  [string]$ObsDirectory = 'C:\Program Files\obs-studio',
  [ValidateSet('com.obsproject.Yami.Original', 'com.obsproject.Yami.Light')]
  [string]$Theme = 'com.obsproject.Yami.Original'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'obs-plugin-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$portableDirectory = Join-Path $projectRoot 'build/obs-portable-copy-test'
New-Item -ItemType Directory -Force -Path $portableDirectory | Out-Null
# Keep both runtime files and all test settings isolated from the user's installed OBS.
foreach ($folder in @('bin', 'data', 'obs-plugins')) {
  $originalFolder = Join-Path $ObsDirectory $folder
  foreach ($file in Get-ChildItem -LiteralPath $originalFolder -File -Recurse) {
    if ($file.Name -eq 'tuna.dll') { continue }
    $relativePath = $file.FullName.Substring($ObsDirectory.TrimEnd([char[]]'\/').Length + 1)
    $targetPath = Join-Path $portableDirectory $relativePath
    if (Test-Path -LiteralPath $targetPath) { continue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
    Copy-Item -LiteralPath $file.FullName -Destination $targetPath
  }
}
$configurationDirectory = Join-Path $portableDirectory 'config/obs-studio'
$legacyConfiguration = Join-Path $configurationDirectory 'plugin_config/discord-voice/settings.json'
$currentConfiguration = Join-Path $configurationDirectory 'plugin_config/vc-mix/settings.json'
if (Test-Path -LiteralPath $currentConfiguration) { Remove-Item -LiteralPath $currentConfiguration }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyConfiguration) | Out-Null
Add-Type -AssemblyName System.Security
$fixtureToken = [System.Text.Encoding]::UTF8.GetBytes('vc-mix-migration-test-token')
$encryptedFixture = [System.Security.Cryptography.ProtectedData]::Protect($fixtureToken, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$migrationFixture = @{
  encrypted_token = [System.BitConverter]::ToString($encryptedFixture).Replace('-', '').ToLowerInvariant()
  guild_id = '111111111111111111'
  channel_id = '222222222222222222'
  excluded_ids = ''
  auto_connect = $false
}
$migrationFixture | ConvertTo-Json | Set-Content -LiteralPath $legacyConfiguration -Encoding utf8
$legacyTestLibrary = Join-Path $portableDirectory 'obs-plugins/64bit/discord-voice.dll'
if (Test-Path -LiteralPath $legacyTestLibrary) { Remove-Item -LiteralPath $legacyTestLibrary }
$previewPath = Join-Path $configurationDirectory 'plugin_config/vc-mix/settings-preview.png'
if (Test-Path -LiteralPath $previewPath) { Remove-Item -LiteralPath $previewPath }
$previousScene = Join-Path $configurationDirectory 'basic/scenes/VCMixTest.json'
if (Test-Path -LiteralPath $previousScene) { Remove-Item -LiteralPath $previousScene }
New-Item -ItemType Directory -Force -Path "$configurationDirectory/basic/profiles/VCMixTest", "$portableDirectory/data/obs-plugins/vc-mix" | Out-Null
Copy-Item -LiteralPath "$projectRoot/dist/vc-mix/bin/64bit/vc-mix.dll" -Destination "$portableDirectory/obs-plugins/64bit" -Force
Copy-PluginDirectory -Source "$projectRoot/dist/vc-mix/data" -Destination "$portableDirectory/data/obs-plugins/vc-mix"
$unusedTestPlugin = Join-Path $portableDirectory 'obs-plugins/64bit/tuna.dll'
if (Test-Path -LiteralPath $unusedTestPlugin) { Remove-Item -LiteralPath $unusedTestPlugin }
@'
[General]
FirstRun=true
LastVersion=536936450
[Basic]
Profile=VCMixTest
ProfileDir=VCMixTest
SceneCollection=VCMixTest
SceneCollectionFile=VCMixTest
[BasicWindow]
PreviewEnabled=false
'@ | Set-Content -LiteralPath "$configurationDirectory/user.ini" -Encoding utf8
Add-Content -LiteralPath "$configurationDirectory/user.ini" -Value "`n[Appearance]`nTheme=$Theme" -Encoding utf8
@'
[General]
FirstRun=true
LastVersion=536936450
[Basic]
Profile=VCMixTest
ProfileDir=VCMixTest
SceneCollection=VCMixTest
SceneCollectionFile=VCMixTest
'@ | Set-Content -LiteralPath "$configurationDirectory/global.ini" -Encoding utf8
@'
[General]
Name=VCMixTest
[Audio]
SampleRate=48000
ChannelSetup=Stereo
[Video]
BaseCX=1280
BaseCY=720
OutputCX=1280
OutputCY=720
FPSType=0
FPSCommon=30
'@ | Set-Content -LiteralPath "$configurationDirectory/basic/profiles/VCMixTest/basic.ini" -Encoding utf8
$executable = Join-Path $portableDirectory 'bin/64bit/obs64.exe'
$process = Start-Process -FilePath $executable -ArgumentList '--portable', '--multi', '--disable-updater', '--disable-shutdown-check', '--disable-missing-files-check', '--vc-mix-test' -WorkingDirectory (Split-Path -Parent $executable) -PassThru -WindowStyle Hidden
$process | Select-Object Id, Path | ConvertTo-Json
if (!$process.WaitForExit(45000)) {
  Stop-Process -Id $process.Id
  throw 'Isolated OBS smoke test timed out. Inspect build/obs-portable-copy-test/config/obs-studio/logs.'
}
$log = Get-ChildItem -LiteralPath "$configurationDirectory/logs" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$log) { throw 'OBS did not create a test log.' }
$logText = Get-Content -LiteralPath $log.FullName -Raw -Encoding utf8
$logText -split '\r?\n' | Where-Object { $_ -match 'vc-mix|Test voice' }
if ($logText -notmatch 'Frontend smoke test PASS') { throw "OBS frontend test failed. See $($log.FullName)." }
if ($process.ExitCode -ne 0) { throw "OBS exited with code $($process.ExitCode)." }
if (!(Test-Path -LiteralPath $currentConfiguration)) { throw 'Renamed plugin did not migrate the previous settings.' }
$migrated = Get-Content -LiteralPath $currentConfiguration -Raw | ConvertFrom-Json
if ($migrated.guild_id -ne $migrationFixture.guild_id -or !$migrated.encrypted_token -or $migrated.auto_connect) { throw 'Settings migration changed saved values.' }
Write-Output 'PASS: Previous plugin settings migrate into the VC Mix configuration directory.'
Write-Output 'PASS: Real OBS loaded the installed plugin, opened settings, created both native sources and received audio.'
$previewPath = Join-Path $configurationDirectory 'plugin_config/vc-mix/settings-preview.png'
if (!(Test-Path -LiteralPath $previewPath)) { throw 'OBS did not render the settings preview.' }
$previewDirectory = Join-Path $projectRoot 'build/ui-previews'
New-Item -ItemType Directory -Force -Path $previewDirectory | Out-Null
$previewName = if ($Theme -eq 'com.obsproject.Yami.Light') { 'settings-light.png' } else { 'settings-dark.png' }
Copy-Item -LiteralPath $previewPath -Destination (Join-Path $previewDirectory $previewName) -Force
Write-Output "Settings preview: $(Join-Path $previewDirectory $previewName)"
