param(
  [string]$ObsDirectory = 'C:\Program Files\obs-studio',
  [string]$ObsVersion = '32.1.2'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'obs-plugin-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$buildDirectory = Join-Path $projectRoot 'build'
$sdkDirectory = Join-Path $buildDirectory 'obs-sdk'
$sourceDirectory = Join-Path $projectRoot ".downloads/obs-studio-$ObsVersion"
New-Item -ItemType Directory -Force -Path $sdkDirectory | Out-Null

if (!(Test-Path -LiteralPath "$sourceDirectory/libobs/obs.h")) {
  New-Item -ItemType Directory -Force -Path "$projectRoot/.downloads" | Out-Null
  $archivePath = Join-Path $projectRoot ".downloads/obs-studio-$ObsVersion-source.zip"
  Invoke-WebRequest -Uri "https://codeload.github.com/obsproject/obs-studio/zip/refs/tags/$ObsVersion" -OutFile $archivePath
  Expand-Archive -LiteralPath $archivePath -DestinationPath "$projectRoot/.downloads" -Force
}

$visualStudio = & "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio) { throw 'Install Visual Studio with Desktop development with C++ before building.' }
$toolchain = Get-ChildItem -LiteralPath "$visualStudio/VC/Tools/MSVC" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$compilerTools = Join-Path $toolchain.FullName 'bin/Hostx64/x64'
foreach ($libraryName in @('obs', 'obs-frontend-api')) {
  $runtimePath = Join-Path $ObsDirectory "bin/64bit/$libraryName.dll"
  if (!(Test-Path -LiteralPath $runtimePath)) { throw "Missing OBS runtime: $runtimePath" }
  $exports = & "$compilerTools/dumpbin.exe" /nologo /exports $runtimePath
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect $runtimePath" }
  $symbols = foreach ($line in $exports) { if ($line -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)') { $Matches[1] } }
  $definitionPath = Join-Path $sdkDirectory "$libraryName.def"
  @("LIBRARY $libraryName.dll", 'EXPORTS') + $symbols | Set-Content -LiteralPath $definitionPath -Encoding ascii
  & "$compilerTools/lib.exe" /nologo "/def:$definitionPath" /machine:x64 "/out:$sdkDirectory/$libraryName.lib"
  if ($LASTEXITCODE -ne 0) { throw "Import library generation failed for $libraryName" }
}
@'
#pragma once
#define OBS_DATA_PATH "data"
#define OBS_PLUGIN_PATH "obs-plugins"
#define OBS_PLUGIN_DESTINATION "obs-plugins/64bit"
#define OBS_RELEASE_CANDIDATE 0
#define OBS_BETA 0
'@ | Set-Content -LiteralPath "$sdkDirectory/obsconfig.h" -Encoding ascii

& "$PSScriptRoot/prepare-opus-runtime.ps1" -ProjectRoot $projectRoot
& "$projectRoot/node_modules/.bin/tsc.cmd" -p tsconfig.helper.json
if ($LASTEXITCODE -ne 0) { throw 'Receiver TypeScript compilation failed.' }
$qtDirectory = & "$PSScriptRoot/prepare-obs-qt.ps1" -ObsSourceDirectory $sourceDirectory -DownloadDirectory "$projectRoot/.downloads" -ObsDirectory $ObsDirectory
& cmake -S "$projectRoot/obs-plugin" -B "$buildDirectory/native" -G 'Visual Studio 18 2026' -A x64 "-DOBS_SOURCE_DIR=$sourceDirectory" "-DOBS_IMPORT_DIR=$sdkDirectory" "-DCMAKE_PREFIX_PATH=$qtDirectory"
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed.' }
& cmake --build "$buildDirectory/native" --config RelWithDebInfo --parallel
if ($LASTEXITCODE -ne 0) { throw 'Native plugin compilation failed.' }

$pluginDirectory = Join-Path $projectRoot 'dist/vc-mix'
$binaryDirectory = Join-Path $pluginDirectory 'bin/64bit'
$helperDirectory = Join-Path $pluginDirectory 'data/helper'
New-Item -ItemType Directory -Force -Path $binaryDirectory, $helperDirectory | Out-Null
Copy-Item -LiteralPath "$buildDirectory/native/RelWithDebInfo/vc-mix.dll" -Destination $binaryDirectory -Force
Copy-PluginDirectory -Source "$buildDirectory/helper/src" -Destination "$helperDirectory/src"
Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination "$helperDirectory/node.exe" -Force
$nodeLicense = Join-Path $projectRoot '.downloads/NODE-LICENSE.txt'
if (!(Test-Path -LiteralPath $nodeLicense)) {
  $nodeVersion = & node.exe --version
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile $nodeLicense
}
Copy-Item -LiteralPath $nodeLicense -Destination "$helperDirectory/NODE-LICENSE.txt" -Force
'{"type":"module","private":true}' | Set-Content -LiteralPath "$helperDirectory/package.json" -Encoding utf8
$productionPackages = & npm.cmd ls --parseable --all --omit=dev
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate locked production dependencies.' }
$runtimeModules = [System.IO.Path]::GetFullPath((Join-Path $helperDirectory 'node_modules'))
if (!$runtimeModules.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $runtimeModules) -ne 'node_modules') {
  throw 'Generated runtime dependencies must remain inside this project.'
}
# Rebuild generated dependencies so removed decoders cannot linger in a release. Node handles long Windows paths.
& node.exe -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });" $runtimeModules
if ($LASTEXITCODE -ne 0) { throw 'Could not clear generated runtime dependencies.' }
foreach ($packagePath in $productionPackages) {
  if ($packagePath -eq $projectRoot) { continue }
  $packagePrefix = $projectRoot + [System.IO.Path]::DirectorySeparatorChar
  if (!$packagePath.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'A dependency is outside this project.' }
  $relativePath = $packagePath.Substring($packagePrefix.Length)
  if (!$relativePath.StartsWith('node_modules') -or $relativePath.Contains('..')) { throw "Unexpected package path: $relativePath" }
  $targetPath = Join-Path $helperDirectory $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-PluginDirectory -Source $packagePath -Destination $targetPath -RuntimeFilesOnly
}
# Remove development declarations left by an older build; they are never needed by the bundled runtime.
$runtimeModules = (Resolve-Path -LiteralPath "$helperDirectory/node_modules").Path
foreach ($developmentFile in Get-ChildItem -LiteralPath $runtimeModules -File -Recurse | Where-Object { $_.Extension -in @('.ts', '.map', '.pdb', '.obj', '.log', '.tlog', '.vcxproj', '.filters') }) {
  if (!$developmentFile.FullName.StartsWith($runtimeModules + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected runtime file path.' }
  Remove-Item -LiteralPath $developmentFile.FullName
}
Copy-Item -LiteralPath "$sourceDirectory/COPYING" -Destination "$pluginDirectory/data/LICENSE.txt" -Force
Copy-Item -LiteralPath "$projectRoot/obs-plugin/README.md" -Destination "$pluginDirectory/README.md" -Force
Write-Output "Built plugin: $pluginDirectory"
