$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "Meteo Analyste - Installation"

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   Meteo Analyste - Installation initiale" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $PSScriptRoot

# Etape 1 - Node.js
Write-Host "[1/4] Verification Node.js..." -ForegroundColor Yellow
try {
    $nodeVersion = node --version 2>&1
    Write-Host "      OK - $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERREUR: Node.js non installe." -ForegroundColor Red
    Write-Host "Telecharge-le sur : https://nodejs.org" -ForegroundColor White
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

# Etape 2 - pnpm
Write-Host ""
Write-Host "[2/4] Installation pnpm..." -ForegroundColor Yellow
npm install -g pnpm
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: echec installation pnpm" -ForegroundColor Red
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}
$pnpmVersion = pnpm --version 2>&1
Write-Host "      OK - pnpm $pnpmVersion" -ForegroundColor Green

# Etape 3 - Dependances
Write-Host ""
Write-Host "[3/4] Installation des dependances (2-3 min)..." -ForegroundColor Yellow
pnpm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: pnpm install echoue" -ForegroundColor Red
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}
Write-Host "      OK - dependances installees" -ForegroundColor Green

# Etape 4 - Base de donnees
Write-Host ""
Write-Host "[4/4] Creation des tables PostgreSQL..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    Write-Host "ERREUR: fichier .env manquant" -ForegroundColor Red
    Write-Host "Copie .env.example en .env et remplis DATABASE_URL" -ForegroundColor White
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}
pnpm --filter @workspace/db run push
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: creation des tables echouee" -ForegroundColor Red
    Write-Host "Verifie que PostgreSQL est demarre et que DATABASE_URL est correcte dans .env" -ForegroundColor White
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}
Write-Host "      OK - tables creees" -ForegroundColor Green

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "   Installation terminee ! Lance start.bat" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
