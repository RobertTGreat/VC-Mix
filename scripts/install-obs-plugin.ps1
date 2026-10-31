param([string]$PluginDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/vc-mix'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'obs-plugin-common.ps1')
$sourceDirectory = (Resolve-Path -LiteralPath $PluginDirectory).Path
if (!(Test-Path -LiteralPath "$sourceDirectory/bin/64bit/vc-mix.dll") -or !(Test-Path -LiteralPath "$sourceDirectory/data/helper/node.exe")) {
  throw 'The complete plugin package is required. Build it or extract the release ZIP first.'
}
$destination = Join-Path $env:PROGRAMDATA 'obs-studio/plugins/vc-mix'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
try {
  $sourceLibrary = Join-Path $sourceDirectory 'bin/64bit/vc-mix.dll'
  $installedLibrary = Join-Path $destination 'bin/64bit/vc-mix.dll'
  if ((Test-Path -LiteralPath $installedLibrary) -and (Get-FileHash -LiteralPath $sourceLibrary).Hash -ne (Get-FileHash -LiteralPath $installedLibrary).Hash) {
    try { Copy-Item -LiteralPath $sourceLibrary -Destination $installedLibrary -Force -ErrorAction Stop }
    catch {
      # A loaded DLL cannot be overwritten. Renaming preserves the running image until OBS exits.
      $backupLibrary = "$installedLibrary.previous-$(Get-Date -Format 'yyyyMMddHHmmssfff')"
      Move-Item -LiteralPath $installedLibrary -Destination $backupLibrary -ErrorAction Stop
      try { Copy-Item -LiteralPath $sourceLibrary -Destination $installedLibrary -Force -ErrorAction Stop }
      catch { Move-Item -LiteralPath $backupLibrary -Destination $installedLibrary; throw }
    }
  }
  Copy-PluginDirectory -Source "$sourceDirectory/bin" -Destination "$destination/bin"
  Copy-PluginDirectory -Source "$sourceDirectory/data" -Destination "$destination/data"
  $legacyLibrary = Join-Path $env:PROGRAMDATA 'obs-studio/plugins/discord-voice/bin/64bit/discord-voice.dll'
  if (Test-Path -LiteralPath $legacyLibrary) {
    $legacyBackup = "$legacyLibrary.disabled-vc-mix-$(Get-Date -Format 'yyyyMMddHHmmssfff')"
    Move-Item -LiteralPath $legacyLibrary -Destination $legacyBackup -ErrorAction Stop
  }
} catch { throw "Could not install VC Mix. Close OBS and run the installer as administrator if folder access is denied. $($_.Exception.Message)" }
Write-Output "Installed VC Mix in $destination"
Write-Output 'Restart OBS, then open Tools > VC Mix.'
