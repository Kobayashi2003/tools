param([int]$Port = 18050)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. If the server is running, open http://127.0.0.1:$Port/ or run .\stop.ps1 first."
}
$taskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        throw 'Python 3.11+ is not on PATH. Install it from https://www.python.org/ and run this again.'
    }
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment (.venv).' }
}
& $taskPython -m pip install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }
& $taskPython main.py serve --port $Port
