param([string]$ProjectRoot)
$ErrorActionPreference = 'Stop'
$metadataCheck = @'
const { readFileSync } = require('node:fs');
const { find } = require('@discordjs/node-pre-gyp');
const binary = readFileSync(find(require.resolve('@discordjs/opus/package.json')));
const projectRoot = process.argv[1];
process.stdout.write(String(binary.includes(Buffer.from(projectRoot)) || binary.includes(Buffer.from(projectRoot.replaceAll('\\', '/')))));
'@
$hasLocalPath = & node.exe -e $metadataCheck $ProjectRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect native decoder build metadata.' }
if ($hasLocalPath -ne 'true') { return }

# npm may compile the addon locally; use a relative PDB reference in the distributed native binary.
$previousLinkOptions = $env:_LINK_
Push-Location -LiteralPath "$ProjectRoot/node_modules/@discordjs/opus"
try {
  $env:_LINK_ = "$previousLinkOptions /PDBALTPATH:opus.pdb"
  & node.exe ../node-pre-gyp/bin/node-pre-gyp rebuild
  if ($LASTEXITCODE -ne 0) { throw 'Could not rebuild the native decoder for distribution.' }
} finally { $env:_LINK_ = $previousLinkOptions; Pop-Location }
$hasLocalPath = & node.exe -e $metadataCheck $ProjectRoot
if ($LASTEXITCODE -ne 0 -or $hasLocalPath -eq 'true') { throw 'The native decoder still contains local build paths.' }
