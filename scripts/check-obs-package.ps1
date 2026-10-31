$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath "$projectRoot/package.json" -Raw | ConvertFrom-Json).version
$archivePath = Join-Path $projectRoot "dist/VC-Mix-$version-Windows-x64.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $requiredEntries = @('vc-mix/bin/64bit/vc-mix.dll', 'vc-mix/data/helper/node.exe', 'vc-mix/data/helper/src/obs/helper.js', 'vc-mix/data/helper/node_modules/@discordjs/opus/package.json', 'vc-mix/data/helper/node_modules/@discordjs/opus/lib/index.js', 'README.md', 'LICENSE', 'source/LICENSE', 'source/installer/vc-mix.nsi', 'docs/images/settings-dark.png')
  $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  foreach ($required in $requiredEntries) { if ($entryNames -notcontains $required) { throw "Release is missing $required" } }
  if (!($entryNames -match '^vc-mix/data/helper/node_modules/@discordjs/opus/prebuild/[^/]+/opus\.node$')) {
    throw 'Release is missing the native C libopus binary.'
  }
  if ($entryNames -match '^vc-mix/data/helper/node_modules/(mediaplex|@mediaplex)/') {
    throw 'Release still contains a removed decoder.'
  }
  if ($entryNames | Where-Object { $_ -match '(^|/)(\.env|routes\.json)$|\.har$' }) { throw 'A private local configuration was included in the release.' }
  if ($entryNames -match '(^|/)(__pycache__|private-history|build-tmp-[^/]+)(/|$)|\.(pyc|pdb|obj|log|tlog|vcxproj|iobj|ipdb|exp|ilk)$|^source/(node_modules|build|dist|\.downloads|\.venv)/') {
    throw 'Generated or private development files were included in the release.'
  }
  $token = ''
  if (Test-Path -LiteralPath "$projectRoot/.env") {
    $tokenLine = Get-Content -LiteralPath "$projectRoot/.env" | Where-Object { $_ -match '^DISCORD_BOT_TOKEN=' } | Select-Object -First 1
    if ($tokenLine) {
      $token = $tokenLine.Substring('DISCORD_BOT_TOKEN='.Length).Trim()
      if ($token.StartsWith('"')) { $token = $token | ConvertFrom-Json }
      elseif ($token.StartsWith("'")) { $token = $token.Trim([char]39) }
    }
  }
  foreach ($entry in $archive.Entries) {
      if ($entry.FullName -notmatch '\.(json|[cm]?js|ts|md|txt|ps1|cmd|py|dll|node)$') { continue }
      $reader = New-Object System.IO.StreamReader($entry.Open())
      try {
        $contents = $reader.ReadToEnd()
        if ($token -and $contents.Contains($token)) { throw 'A local credential was found in the release.' }
        if ($contents.Contains($projectRoot) -or $contents.Contains($projectRoot.Replace('\', '/'))) { throw 'A local build path was found in the release.' }
      }
      finally { $reader.Dispose() }
  }
  Write-Output "PASS: Release contains all required files ($($entryNames.Count) entries), with no local settings or bot token."
} finally { $archive.Dispose() }
