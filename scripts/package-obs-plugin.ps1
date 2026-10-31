$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'obs-plugin-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath "$projectRoot/package.json" -Raw | ConvertFrom-Json).version
$releaseDirectory = Join-Path $projectRoot 'dist'
$pluginDirectory = Join-Path $releaseDirectory 'vc-mix'
if (!(Test-Path -LiteralPath "$pluginDirectory/bin/64bit/vc-mix.dll")) { throw 'Run npm run build:obs first.' }
& git.exe -C $projectRoot diff --quiet
if ($LASTEXITCODE -ne 0) { throw 'Stage the final public source changes before packaging.' }
& node.exe "$PSScriptRoot/check-public-source.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Public source checks must pass before packaging.' }

$packageDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'build/release-package'))
if (!$packageDirectory.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $packageDirectory) -ne 'release-package') {
  throw 'Release staging must stay inside this project.'
}
& node.exe -e "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });" $packageDirectory
if ($LASTEXITCODE -ne 0) { throw 'Could not reset generated release staging.' }
$sourceDirectory = Join-Path $packageDirectory 'source'
New-Item -ItemType Directory -Force -Path $sourceDirectory | Out-Null
$publicFiles = & git.exe -C $projectRoot ls-files
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate public source files.' }
foreach ($relativePath in $publicFiles) {
  if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath.Split('/') -contains '..') { throw 'Unexpected source path.' }
  $targetPath = Join-Path $sourceDirectory $relativePath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot $relativePath) -Destination $targetPath -Force
}
foreach ($filename in @('README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath "$projectRoot/$filename" -Destination "$packageDirectory/$filename" -Force
  Copy-Item -LiteralPath "$projectRoot/$filename" -Destination "$pluginDirectory/$filename" -Force
}
Copy-PluginDirectory -Source "$projectRoot/docs" -Destination "$packageDirectory/docs"
Copy-PluginDirectory -Source "$projectRoot/docs" -Destination "$pluginDirectory/docs"
$archivePath = Join-Path $releaseDirectory "VC-Mix-$version-Windows-x64.zip"
Compress-Archive -LiteralPath $pluginDirectory, $sourceDirectory, "$packageDirectory/README.md", "$packageDirectory/LICENSE", "$packageDirectory/THIRD_PARTY_NOTICES.md", "$packageDirectory/docs" -DestinationPath $archivePath -Force -CompressionLevel Optimal
Write-Output "Release package: $archivePath"
