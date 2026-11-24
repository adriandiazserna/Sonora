# Compila Sonora y crea un acceso directo en el escritorio.
# Uso:  powershell -ExecutionPolicy Bypass -File build.ps1        (versión final en .\dist)
#       powershell -ExecutionPolicy Bypass -File build.ps1 -Dev   (compila y abre en modo desarrollo)
param([switch]$Dev)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
$sdks = if ($dotnet) { & $dotnet --list-sdks } else { $null }
if (-not $sdks) {
    Write-Host "Falta el SDK de .NET 8. Instálalo con:" -ForegroundColor Yellow
    Write-Host "  winget install Microsoft.DotNet.SDK.8" -ForegroundColor Cyan
    exit 1
}

if ($Dev) {
    & $dotnet run -c Debug
    exit $LASTEXITCODE
}

& $dotnet publish -c Release -r win-x64 --self-contained false -p:PublishReadyToRun=true -o dist
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$exe = Join-Path $PSScriptRoot 'dist\Sonora.exe'
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Sonora.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = $exe
$s.WorkingDirectory = Split-Path $exe
$s.Description = 'Sonora — reproductor de música'
$s.Save()
Write-Host "Listo: $exe  (acceso directo en el escritorio)" -ForegroundColor Green
