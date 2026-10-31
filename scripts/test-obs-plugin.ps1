param([string]$ObsDirectory = 'C:\Program Files\obs-studio')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$previousPath = $env:PATH
$previousPlatformPath = $env:QT_QPA_PLATFORM_PLUGIN_PATH
$previousScaleFactor = $env:QT_SCALE_FACTOR
try {
  $env:PATH = "$ObsDirectory/bin/64bit;$previousPath"
  $env:QT_QPA_PLATFORM_PLUGIN_PATH = "$ObsDirectory/bin/64bit/platforms"
  & "$projectRoot/build/native/RelWithDebInfo/vc-mix-settings-test.exe" "$projectRoot/dist/vc-mix/data/helper"
  if ($LASTEXITCODE -ne 0) { throw "Settings input regression tests failed ($LASTEXITCODE)." }
  $env:QT_SCALE_FACTOR = '1.5'
  & "$projectRoot/build/native/RelWithDebInfo/vc-mix-settings-test.exe"
  if ($LASTEXITCODE -ne 0) { throw "Settings high-DPI regression tests failed ($LASTEXITCODE)." }
  $env:QT_SCALE_FACTOR = $previousScaleFactor
  & "$projectRoot/build/native/RelWithDebInfo/vc-mix-integration.exe" "$projectRoot/dist/vc-mix/data/helper" "$projectRoot/build/test-settings/settings.json"
  if ($LASTEXITCODE -ne 0) { throw "Native integration tests failed ($LASTEXITCODE)." }
} finally {
  $env:PATH = $previousPath
  $env:QT_QPA_PLATFORM_PLUGIN_PATH = $previousPlatformPath
  $env:QT_SCALE_FACTOR = $previousScaleFactor
}
