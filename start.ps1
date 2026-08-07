$Host.UI.RawUI.WindowTitle = "Meteo Analyste - Demarrage"
$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "   Meteo Analyste - Demarrage" -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path ".env")) {
    Write-Host "ERREUR: fichier .env manquant." -ForegroundColor Red
    Write-Host "Cree un fichier .env avec:" -ForegroundColor White
    Write-Host "  DATABASE_URL=postgresql://postgres:MOTDEPASSE@localhost:5432/meteo_analyste" -ForegroundColor Yellow
    Write-Host "  SESSION_SECRET=un_secret_ici" -ForegroundColor Yellow
    Write-Host "  API_PORT=8090" -ForegroundColor Yellow
    Write-Host "  FRONTEND_PORT=5173" -ForegroundColor Yellow
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}

# --- Lire les ports depuis .env ---
$apiPort = "8090"
$frontendPort = "5173"
Get-Content ".env" | ForEach-Object {
    if ($_ -match "^API_PORT=(.+)$")      { $apiPort = $Matches[1].Trim() }
    if ($_ -match "^FRONTEND_PORT=(.+)$") { $frontendPort = $Matches[1].Trim() }
}

# --- Arreter les anciens processus sur ces ports ---
Write-Host "[0/5] Arret des anciens serveurs (ports $apiPort et $frontendPort)..." -ForegroundColor Yellow
foreach ($p in @([int]$apiPort, [int]$frontendPort)) {
    try {
        $conn = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
        if ($conn) {
            $pid2 = $conn.OwningProcess | Select-Object -First 1
            Stop-Process -Id $pid2 -Force -ErrorAction SilentlyContinue
            Write-Host "      Port $p libere" -ForegroundColor Gray
        }
    } catch {}
}
Start-Sleep -Seconds 1

# --- Ouvrir les ports dans le pare-feu Windows ---
Write-Host "[0/5] Ouverture des ports dans le pare-feu Windows..." -ForegroundColor Yellow
foreach ($port in @($apiPort, $frontendPort)) {
    $ruleName = "MeteoAnalyste-$port"
    $exists = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if (-not $exists) {
        try {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
            Write-Host "      Port $port ouvert dans le pare-feu" -ForegroundColor Green
        } catch {
            Write-Host "      Impossible d'ouvrir le port $port (relance en Administrateur si besoin)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "      Port $port deja autorise" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "[1/5] Recuperation des mises a jour..." -ForegroundColor Yellow
# git pull est "best effort" (pas de remote configure sur certains postes) —
# ne doit jamais faire echouer le demarrage. Ne pas rediriger stderr (2>&1) :
# en PowerShell 5.1 ca transforme n'importe quel message stderr d'une commande
# native en erreur terminante des que $ErrorActionPreference = "Stop", meme si
# la commande a reussi.
# HP developpe sur "master", svrprevi tourne sur "main" (historique git
# separe a l'origine) - sur main on fusionne master automatiquement pour ne
# jamais avoir a le faire a la main.
try {
    git fetch origin | Out-Null
    $currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($currentBranch -eq "main") {
        git merge origin/master -m "merge master into main" | Out-Null
        git push origin main | Out-Null
    } else {
        git merge "origin/$currentBranch" | Out-Null
    }
} catch { Write-Host "      (pas de mise a jour recuperee, on continue)" -ForegroundColor Gray }

# Un merge en conflit laisse le depot dans un etat mi-fusionne : le catch
# ci-dessus ne le detecte pas (git merge peut retourner un exit code sans
# lever d'exception PowerShell). On verifie explicitement pour ne jamais
# demarrer silencieusement sur du code a moitie fusionne.
$unmerged = git diff --name-only --diff-filter=U 2>$null
if ($unmerged) {
    Write-Host "      CONFLIT DE FUSION sur : $($unmerged -join ', ')" -ForegroundColor Red
    Write-Host "      Le demarrage continue sur le code d'AVANT le merge tente." -ForegroundColor Red
    Write-Host "      Resous le conflit a la main (git status) puis relance." -ForegroundColor Red
    git merge --abort 2>$null | Out-Null
} else {
    Write-Host "      OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "[2/5] Installation des dependances..." -ForegroundColor Yellow
pnpm install | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: pnpm install echoue" -ForegroundColor Red
    Read-Host "Appuie sur Entree pour fermer"
    exit 1
}
# Compilation des modules natifs (ssh2 / cpu-features)
pnpm rebuild cpu-features ssh2 | Out-Null
Write-Host "      OK" -ForegroundColor Green

Write-Host ""
Write-Host "[2b/5] Compilation (production - jamais 'dev', qui tourne sur des ports separes pour les developpeurs)..." -ForegroundColor Yellow
pnpm --filter @workspace/api-server run build | Out-Null
pnpm --filter @workspace/meteo-analyste run build | Out-Null
Write-Host "      OK" -ForegroundColor Green

Write-Host ""
Write-Host "[3/5] Demarrage du serveur API (port $apiPort)..." -ForegroundColor Yellow
Start-Process cmd -ArgumentList "/k title API Server && pnpm --filter @workspace/api-server run start" -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 5

Write-Host "[4/5] Demarrage du frontend (port $frontendPort)..." -ForegroundColor Yellow
Start-Process cmd -ArgumentList "/k title Frontend Meteo && pnpm --filter @workspace/meteo-analyste run serve" -WorkingDirectory $PSScriptRoot
Start-Sleep -Seconds 4

# ── Tunnel Cloudflare ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[5/5] Tunnel Cloudflare..." -ForegroundColor Yellow

# Chercher cloudflared (PATH, dossier local, emplacements communs)
$cloudflared = $null
$candidates = @(
    "cloudflared",
    "$PSScriptRoot\cloudflared.exe",
    "C:\Program Files\cloudflared\cloudflared.exe",
    "C:\cloudflared\cloudflared.exe",
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"
)
foreach ($c in $candidates) {
    if (Get-Command $c -ErrorAction SilentlyContinue) { $cloudflared = $c; break }
    if (Test-Path $c -ErrorAction SilentlyContinue) { $cloudflared = $c; break }
}

# Telecharger cloudflared si absent
if (-not $cloudflared) {
    Write-Host "      cloudflared absent, telechargement automatique..." -ForegroundColor Yellow
    $dest = "$PSScriptRoot\cloudflared.exe"
    try {
        Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $dest -UseBasicParsing
        $cloudflared = $dest
        Write-Host "      cloudflared.exe telecharge." -ForegroundColor Green
    } catch {
        Write-Host "      Echec du telechargement cloudflared - tunnel desactive." -ForegroundColor Red
    }
}

$publicUrl = $null
$tunnelConfig = "$PSScriptRoot\cloudflared-tunnel.yml"

if ($cloudflared) {
    if (Test-Path $tunnelConfig) {
        # ── Tunnel permanent configure via cloudflared-tunnel.yml ──────────────
        Write-Host "      Demarrage tunnel permanent..." -ForegroundColor Cyan
        Start-Process cmd -ArgumentList "/k title Cloudflare Tunnel && `"$cloudflared`" tunnel --config `"$tunnelConfig`" run" -WorkingDirectory $PSScriptRoot
        try {
            $hostname = (Get-Content $tunnelConfig | Select-String "hostname:").ToString().Split(":")[1].Trim()
            $publicUrl = "https://$hostname"
        } catch {}
    } else {
        # ── Tunnel rapide : cloudflared en fond, stderr dans un fichier ──────
        Write-Host "      Demarrage tunnel rapide, recuperation URL en cours..." -ForegroundColor Cyan

        $logFile = "$env:TEMP\meteo-cf-$PID.log"
        if (Test-Path $logFile) { Remove-Item $logFile -Force }

        # cloudflared ecrit l'URL sur stderr -> RedirectStandardError le capture
        $cfProc = Start-Process `
            -FilePath $cloudflared `
            -ArgumentList "tunnel","--url","http://127.0.0.1:$frontendPort" `
            -RedirectStandardError $logFile `
            -PassThru -WindowStyle Minimized

        # Attendre jusqu'a 30s que l'URL apparaisse dans le log
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Seconds 1
            if (Test-Path $logFile) {
                $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
                if ($content -match "https://[a-z0-9-]+\.trycloudflare\.com") {
                    $publicUrl = $Matches[0]
                    break
                }
            }
        }

        if (-not $publicUrl) {
            Write-Host "      URL non detectee - verifie la fenetre cloudflared." -ForegroundColor Yellow
        }
    }
}

# --- Affichage final et sauvegarde ---
Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "   Application demarree !" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Local  : http://localhost:$frontendPort" -ForegroundColor White
Write-Host "   LAN    : http://192.168.0.222:$frontendPort" -ForegroundColor White

if ($publicUrl) {
    Write-Host ""
    Write-Host "   PUBLIC : $publicUrl" -ForegroundColor Cyan
    # Sauvegarder dans un fichier texte pour retrouver facilement
    $publicUrl | Out-File -FilePath "$PSScriptRoot\tunnel-url.txt" -Encoding UTF8
    # Ouvrir dans le navigateur
    Start-Sleep -Seconds 2
    Start-Process $publicUrl
} else {
    Write-Host ""
    Write-Host "   PUBLIC : tunnel non disponible" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "   (attends 15 sec que tout charge au premier lancement)" -ForegroundColor Gray
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Appuie sur Entree pour fermer cette fenetre"
