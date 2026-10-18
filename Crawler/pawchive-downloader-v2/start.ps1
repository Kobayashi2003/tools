# Starts the server and opens it in the browser (-NoBrowser to skip); .\stop.ps1 stops it
# from another window. Needs Python 3.14; the first run sets up .venv.
param([int]$Port = 18060, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. If Pawchive v2 is running, open http://127.0.0.1:$Port/ or run .\stop.ps1 first."
}

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (Get-Command uv -ErrorAction SilentlyContinue) {
    # Where uv is installed, it installs the exact versions in uv.lock.
    uv sync --locked
    if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed; check the network or proxy and run this again.' }
} else {
    if (-not (Test-Path -LiteralPath $venvPython)) {
        # The Windows launcher picks 3.14 among several installs; otherwise `python` must be it.
        $exe, $pick = 'python', @()
        if (Get-Command py -ErrorAction SilentlyContinue) { $exe, $pick = 'py', @('-3.14') }
        & $exe @pick -c 'import sys; sys.exit(sys.version_info < (3, 14))' 2>$null
        if ($LASTEXITCODE -ne 0) { throw 'Python 3.14 was not found. Install it from https://www.python.org/downloads/ and run this again.' }
        & $exe @pick -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Creating .venv failed.' }
    }
    & $venvPython -m pip --version *> $null
    if ($LASTEXITCODE -ne 0) { & $venvPython -m ensurepip --upgrade *> $null }
    # The dependencies are read from pyproject.toml, so it stays their only list.
    $deps = & $venvPython -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']))"
    & $venvPython -m pip install --disable-pip-version-check --quiet @($deps -split "`n" | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed; check the network or proxy and run this again.' }
}

Write-Host "Pawchive v2 on http://127.0.0.1:$Port/  (Ctrl+C or .\stop.ps1 to stop)"
# The server records its own PID and start time in .running.json for stop.ps1.
if (-not $NoBrowser) {
    # Open the page once it answers; the job ends with this script.
    $null = Start-ThreadJob -ArgumentList "http://127.0.0.1:$Port/" -ScriptBlock {
        param($url)
        for ($i = 0; $i -lt 240; $i++) {
            try { $null = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2; Start-Process $url; return }
            catch { if ($_.Exception.Response) { Start-Process $url; return } }
            Start-Sleep -Milliseconds 500
        }
    }
}
& $venvPython main.py serve --port $Port
