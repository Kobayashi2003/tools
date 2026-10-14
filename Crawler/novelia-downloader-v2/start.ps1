param([int]$Port = 18030)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. If the server is running, open http://127.0.0.1:$Port/ or run .\stop.ps1 first."
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is not on PATH (https://docs.astral.sh/uv/).'
}
uv sync --locked
if ($LASTEXITCODE -ne 0) { throw 'Could not install dependencies; check the network or proxy and run this again.' }
uv run --locked python main.py serve --port $Port
