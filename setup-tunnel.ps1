# ============================================================
#  setup-tunnel.ps1 — Configuration du tunnel Cloudflare permanent
#  A executer UNE SEULE FOIS sur ce serveur
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Tunnel Cloudflare permanent - Configuration initiale" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# --- Trouver cloudflared ---
$cloudflared = $null
$candidates = @(
    "cloudflared",
    "C:\Program Files\cloudflared\cloudflared.exe",
    "C:\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe"
)
foreach ($c in $candidates) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $cloudflared = $c; break }
    if (Test-Path $c) { $cloudflared = $c; break }
}

if (-not $cloudflared) {
    Write-Host "cloudflared non trouve. Telechargement automatique..." -ForegroundColor Yellow
    $dest = "$PSScriptRoot\cloudflared.exe"
    $url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Write-Host "  Telechargement depuis $url ..." -ForegroundColor Gray
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    $cloudflared = $dest
    Write-Host "  cloudflared.exe telecharge dans $dest" -ForegroundColor Green
}

Write-Host "cloudflared : $cloudflared" -ForegroundColor Green
Write-Host ""

# --- Lire les ports depuis .env ---
$apiPort = "8090"
$frontendPort = "5173"
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^API_PORT=(.+)$")      { $apiPort = $Matches[1].Trim() }
        if ($_ -match "^FRONTEND_PORT=(.+)$") { $frontendPort = $Matches[1].Trim() }
    }
}

Write-Host "Port API detecte      : $apiPort"
Write-Host "Port Frontend detecte : $frontendPort"
Write-Host ""

# --- Authentification Cloudflare ---
Write-Host "[1/4] Authentification Cloudflare (ouvre le navigateur)..." -ForegroundColor Yellow
Write-Host "      Connecte-toi avec le compte Cloudflare qui gere ton domaine." -ForegroundColor White
& $cloudflared tunnel login
if ($LASTEXITCODE -ne 0) { Write-Host "Erreur d'authentification." -ForegroundColor Red; Read-Host "Entree"; exit 1 }
Write-Host "      Authentifie." -ForegroundColor Green
Write-Host ""

# --- Creer le tunnel ---
$tunnelName = "meteo-analyste"
Write-Host "[2/4] Creation du tunnel '$tunnelName'..." -ForegroundColor Yellow
$createOutput = & $cloudflared tunnel create $tunnelName 2>&1 | Out-String
Write-Host $createOutput -ForegroundColor Gray

# Extraire l'ID du tunnel
$tunnelId = ($createOutput | Select-String -Pattern "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").Matches.Value | Select-Object -First 1
if (-not $tunnelId) {
    # Peut-etre le tunnel existe deja - recuperer son ID
    $listOutput = & $cloudflared tunnel list 2>&1 | Out-String
    $tunnelId = ($listOutput | Select-String -Pattern "$tunnelName\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").Matches.Groups[1].Value
}
if (-not $tunnelId) {
    Write-Host "Impossible d'obtenir l'ID du tunnel. Verifie la sortie ci-dessus." -ForegroundColor Red
    Read-Host "Entree"; exit 1
}
Write-Host "      Tunnel ID : $tunnelId" -ForegroundColor Green
Write-Host ""

# --- Fichier de credentials ---
$credFile = "$env:USERPROFILE\.cloudflared\$tunnelId.json"

# --- Demander le sous-domaine ---
Write-Host "[3/4] Configuration DNS" -ForegroundColor Yellow
Write-Host "      Quel sous-domaine veux-tu utiliser pour l'app ?" -ForegroundColor White
Write-Host "      Exemple : meteo.tondomaine.com" -ForegroundColor Gray
$hostname = Read-Host "      Sous-domaine"
$hostname = $hostname.Trim()

& $cloudflared tunnel route dns $tunnelName $hostname
if ($LASTEXITCODE -ne 0) {
    Write-Host "Attention: erreur DNS - verifie que le domaine est bien sur Cloudflare." -ForegroundColor Yellow
}
Write-Host "      DNS configure." -ForegroundColor Green
Write-Host ""

# --- Ecrire le fichier de config ---
Write-Host "[4/4] Generation du fichier de configuration..." -ForegroundColor Yellow
$configContent = @"
tunnel: $tunnelId
credentials-file: $credFile

ingress:
  - hostname: $hostname
    service: http://127.0.0.1:$frontendPort
  - service: http_status:404
"@
$configPath = "$PSScriptRoot\cloudflared-tunnel.yml"
Set-Content -Path $configPath -Value $configContent -Encoding UTF8
Write-Host "      Config ecrite : $configPath" -ForegroundColor Green
Write-Host ""

# --- Installer comme service Windows ---
Write-Host "Installer le tunnel comme service Windows (demarre au boot) ? [O/N]" -ForegroundColor Cyan
$resp = Read-Host
if ($resp -match "^[Oo]") {
    & $cloudflared service install
    Write-Host "      Service installe. Il demarrera automatiquement au prochain reboot." -ForegroundColor Green
    Write-Host "      Pour demarrer maintenant : net start cloudflared" -ForegroundColor White
} else {
    Write-Host "      Le tunnel sera demarre via start.bat a chaque fois." -ForegroundColor White
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "   Configuration terminee !" -ForegroundColor Green
Write-Host "   Ton app sera accessible sur : https://$hostname" -ForegroundColor White
Write-Host "   Lance start.bat pour demarrer l'application." -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Appuie sur Entree pour fermer"
