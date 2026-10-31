param([string]$ObsSourceDirectory, [string]$DownloadDirectory, [string]$ObsDirectory)
$ErrorActionPreference = 'Stop'
$presets = Get-Content -LiteralPath (Join-Path $ObsSourceDirectory 'CMakePresets.json') -Raw | ConvertFrom-Json
$dependencyPreset = $presets.configurePresets | Where-Object { $_.name -eq 'dependencies' }
$qtDependency = $dependencyPreset.vendor.'obsproject.com/obs-studio'.dependencies.qt6
if (!$qtDependency.version -or !$qtDependency.hashes.'windows-x64') { throw 'OBS does not declare a Windows x64 Qt SDK.' }
$archiveName = "windows-deps-qt6-$($qtDependency.version)-x64.zip"
$archivePath = Join-Path $DownloadDirectory $archiveName
$qtDirectory = Join-Path $DownloadDirectory "obs-qt6-$($qtDependency.version)-x64"
if (!(Test-Path -LiteralPath "$qtDirectory/lib/cmake/Qt6/Qt6Config.cmake")) {
  if (!(Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -Uri "$($qtDependency.baseUrl)/$($qtDependency.version)/$archiveName" -OutFile $archivePath
  }
  if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $qtDependency.hashes.'windows-x64') {
    throw 'Qt SDK checksum does not match the OBS build manifest.'
  }
  Expand-Archive -LiteralPath $archivePath -DestinationPath $qtDirectory -Force
}
$sdkVersion = (Get-Item -LiteralPath "$qtDirectory/bin/Qt6Core.dll").VersionInfo.FileVersion
$runtimeVersion = (Get-Item -LiteralPath "$ObsDirectory/bin/64bit/Qt6Core.dll").VersionInfo.FileVersion
if ($sdkVersion -ne $runtimeVersion) { throw "Qt SDK $sdkVersion does not match the installed OBS Qt runtime $runtimeVersion." }
Write-Output $qtDirectory
