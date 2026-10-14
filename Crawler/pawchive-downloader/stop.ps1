# Ends a shell .\start.ps1 opened, from another window. Unfinished posts stay pending for the
# next run.
$ErrorActionPreference = 'Stop'
$python = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.venv\Scripts\python.exe'))
# The venv's python.exe is a launcher; taskkill /T takes the interpreter it started with it.
$shells = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.ExecutablePath -eq $python -and $_.CommandLine -match 'main\.py' }
if (-not $shells) { Write-Host 'Not running.'; return }
foreach ($shell in $shells) {
    taskkill /F /T /PID $shell.ProcessId 2>&1 | Out-Null
    Write-Host "Stopped pawchive (PID $($shell.ProcessId))."
}
