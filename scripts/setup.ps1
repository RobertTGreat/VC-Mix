$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Install Node.js 22.12 or newer and retry.' }

if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment. Install Python 3.11 or newer.' }
}

& '.venv/Scripts/python.exe' -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Audio dependency installation failed.' }

npm run doctor
if ($LASTEXITCODE -ne 0) { throw 'A prerequisite check failed. See the output above.' }
Write-Host 'Setup complete. Next: npm run configure'
