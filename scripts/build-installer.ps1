param([string]$NsisCompiler = '', [switch]$TestBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath "$projectRoot/package.json" -Raw | ConvertFrom-Json).version
$payloadDirectory = Join-Path $projectRoot 'dist/vc-mix'
if (!(Test-Path -LiteralPath "$payloadDirectory/bin/64bit/vc-mix.dll")) { throw 'Run npm run build:obs first.' }

if (!$NsisCompiler) {
  $toolDirectory = Join-Path $projectRoot '.downloads/nsis-3.13'
  $NsisCompiler = Join-Path $toolDirectory 'makensis.exe'
  if (!(Test-Path -LiteralPath $NsisCompiler)) {
    $archivePath = Join-Path $projectRoot '.downloads/nsis-3.13.zip'
    $expectedHash = 'ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8'
    if (!(Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath).Hash -ne $expectedHash) {
      Invoke-WebRequest -Uri 'https://netix.dl.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip' -OutFile $archivePath
    }
    if ((Get-FileHash -LiteralPath $archivePath).Hash -ne $expectedHash) { throw 'NSIS checksum verification failed.' }
    Expand-Archive -LiteralPath $archivePath -DestinationPath "$projectRoot/.downloads" -Force
  }
}

$outputPath = Join-Path $projectRoot "dist/VC-Mix-$version-Windows-x64-Setup.exe"
$compilerArguments = @('/V2', "/DPRODUCT_VERSION=$version", "/DPROJECT_DIR=$projectRoot", "/DPAYLOAD_DIR=$payloadDirectory")
if ($TestBuild) {
  $testDirectory = Join-Path $projectRoot 'build/installer-test'
  New-Item -ItemType Directory -Force -Path $testDirectory | Out-Null
  $outputPath = Join-Path $testDirectory 'vc-mix-test-setup.exe'
  $compilerArguments += '/DTEST_INSTALLER'
}
$compilerArguments += @("/DOUTPUT_PATH=$outputPath", "$projectRoot/installer/vc-mix.nsi")
& $NsisCompiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'NSIS installer compilation failed.' }
Write-Output "Installer: $outputPath"
