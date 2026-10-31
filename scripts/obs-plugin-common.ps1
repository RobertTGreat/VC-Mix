function Copy-PluginDirectory {
  param([string]$Source, [string]$Destination, [switch]$RuntimeFilesOnly)
  # Robocopy supports long Windows paths used by nested npm packages on Windows PowerShell 5.
  $copyArguments = @($Source, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  if ($RuntimeFilesOnly) {
    $excludedFiles = @('*.ts', '*.map', '*.pdb', '*.obj', '*.log', '*.tlog', '*.lastbuildstate', '*.vcxproj', '*.vcxproj.filters')
    if ((Split-Path -Leaf $Source) -eq 'opus' -and (Split-Path -Leaf (Split-Path -Parent $Source)) -eq '@discordjs') {
      $excludedFiles += @('*.exp', '*.iobj', '*.ipdb', '*.lib', '*.ilk')
      $copyArguments += @('/XD', 'build', 'build-tmp-*')
    }
    $copyArguments += @('/XF') + $excludedFiles
  }
  & robocopy.exe @copyArguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Could not copy plugin files from '$Source' to '$Destination' (robocopy code $LASTEXITCODE)." }
}
