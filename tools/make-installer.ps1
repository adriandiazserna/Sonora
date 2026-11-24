# Crea el instalador de Sonora:  installer\out\Sonora-<versión>-<arch>-Setup.exe
# Uso:  powershell -ExecutionPolicy Bypass -File tools\make-installer.ps1 [-Arch x64|x86]
# Requiere .NET 8 SDK e Inno Setup 6  (winget install JRSoftware.InnoSetup)
param([ValidateSet('x64', 'x86')][string]$Arch = 'x64')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location $root

$iscc = @(
    (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source,
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    Write-Host "Falta Inno Setup 6. Instálalo con:  winget install JRSoftware.InnoSetup" -ForegroundColor Yellow
    exit 1
}

$version = ([xml](Get-Content Sonora.csproj)).Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
$app = Join-Path $root 'installer\out\app'
if (Test-Path $app) { Remove-Item $app -Recurse -Force }

# Autocontenido: la PC destino no necesita tener .NET instalado
dotnet publish Sonora.csproj -c Release -r "win-$Arch" --self-contained true -p:PublishReadyToRun=true -p:DebugType=none -o $app
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-ChildItem $app -Filter *.xml | Remove-Item

& $iscc /Q "/DAppVersion=$version" "/DArch=$Arch" installer\Sonora.iss
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$setup = Join-Path $root "installer\out\Sonora-$version-$Arch-Setup.exe"
Write-Host "Listo: $setup" -ForegroundColor Green
