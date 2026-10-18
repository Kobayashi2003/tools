<#
.SYNOPSIS
Builds the QuickLook plugins in this folder into dist\<name>.qlplugin.

.EXAMPLE
./build.ps1 -Install
Builds every plugin, copies it into QuickLook's user plugin folder and restarts QuickLook.
#>
param(
    # Plugin projects to build, e.g. QuickLook.Plugin.FolderViewer; all of them by default.
    [string[]]$Plugin,
    # Also install into QuickLook, stopping it while the files are replaced and starting it again.
    [switch]$Install,
    # The folder holding QuickLook.exe; defaults to the Scoop install.
    [string]$QuickLookDir
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    throw 'dotnet is not on PATH. Install the .NET SDK 8 or newer.'
}

if (-not $QuickLookDir) {
    $scoop = if ($env:SCOOP) { $env:SCOOP } else { Join-Path $env:USERPROFILE 'scoop' }
    $QuickLookDir = Join-Path $scoop 'apps\quicklook\current'
}
if (-not (Test-Path (Join-Path $QuickLookDir 'QuickLook.Common.dll'))) {
    throw "QuickLook.Common.dll not found in '$QuickLookDir'. Pass -QuickLookDir <folder holding QuickLook.exe>."
}

$projects = @(Get-ChildItem $PSScriptRoot -Directory -Filter 'QuickLook.Plugin.*' |
    Where-Object { $_.Name -notlike '*.Tests' -and (-not $Plugin -or $Plugin -contains $_.Name) })
if ($projects.Count -eq 0) {
    throw "No plugin project matches '$Plugin'."
}

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem

$built = @{}
foreach ($project in $projects) {
    # A plugin with a web/ front end (pnpm) ships that build inside the plugin.
    $web = Join-Path $project.FullName 'web'
    if (Test-Path (Join-Path $web 'package.json')) {
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
            throw "pnpm is not on PATH; $($project.Name) needs it to build web\. Install it with 'npm install -g pnpm'."
        }
        Push-Location $web
        try {
            pnpm install --frozen-lockfile
            if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in $web." }
            pnpm build
            if ($LASTEXITCODE -ne 0) { throw "Web build of $($project.Name) failed." }
        }
        finally {
            Pop-Location
        }
    }

    $output = Join-Path $project.FullName 'bin\Release'
    # A clean output folder keeps files from earlier builds out of the package.
    if (Test-Path $output) { Remove-Item -Recurse -Force $output }

    dotnet build $project.FullName -c Release "-p:QuickLookDir=$QuickLookDir"
    if ($LASTEXITCODE -ne 0) { throw "Build of $($project.Name) failed." }

    $files = @(Get-ChildItem $output -File -Recurse | Where-Object Extension -ne '.pdb')
    $package = Join-Path $dist "$($project.Name).qlplugin"
    Remove-Item $package -ErrorAction Ignore
    $zip = [IO.Compression.ZipFile]::Open($package, 'Create')
    try {
        foreach ($file in $files) {
            $entry = $file.FullName.Substring($output.Length + 1).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entry) | Out-Null
        }
    }
    finally {
        $zip.Dispose()
    }
    Write-Host "Packaged $package"
    $built[$project.Name] = $output
}

if (-not $Install) { return }

# Portable QuickLook (the Scoop install) keeps user data beside the exe.
$userData = if (Test-Path (Join-Path $QuickLookDir 'portable.lock')) {
    Join-Path $QuickLookDir 'UserData'
} else {
    Join-Path $env:APPDATA 'pooi.moe\QuickLook'
}

# QuickLook holds its plugin DLLs open, so it must be stopped to replace them.
$running = @(Get-Process QuickLook -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host 'Stopping QuickLook to replace plugin files...'
    $running | Stop-Process -Force
    $running | Wait-Process -Timeout 10
}

foreach ($name in $built.Keys) {
    $target = Join-Path $userData "QuickLook.Plugin\$name"
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item $built[$name] $target -Recurse
    Remove-Item (Join-Path $target '*.pdb') -ErrorAction Ignore
    Write-Host "Installed $name to $target"
}

if ($running.Count -gt 0) {
    Start-Process (Join-Path $QuickLookDir 'QuickLook.exe')
    Write-Host 'Restarted QuickLook.'
}
