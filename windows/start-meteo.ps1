$project = "C:\Users\svrprevi\Desktop\Noaa\GFS_conducteurs"
$apiPort = 8091
$webPort = 3001

Set-Location $project

Write-Host ""
Write-Host "================================================"
Write-Host "     METEO ANALYSTE - Demarrage"
Write-Host "================================================"
Write-Host ""

# Etape 1 : Mise a jour du code. HP developpe sur "master", svrprevi tourne
# sur "main" (historique git separe a l'origine) - on fusionne master dans
# main automatiquement pour ne jamais avoir a le faire a la main.
Write-Host "[1/5] Mise a jour du code..."
try {
    git fetch origin | Out-Null
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -eq "main") {
        git merge origin/master -m "merge master into main" | Out-Null
        git push origin main | Out-Null
    } else {
        git merge "origin/$branch" | Out-Null
    }
    Write-Host "   OK."
} catch {
    Write-Host "   (mise a jour impossible, on continue avec le code local)"
}
Write-Host ""

# Etape 2 : Dependances
Write-Host "[2/5] Installation des dependances..."
pnpm install | Out-Null
Write-Host "   OK."
Write-Host ""

# Etape 3 : Compilation. On compile toujours en production (build + start/
# serve), jamais "dev" (tsx watch / vite dev) - "dev" est reserve aux
# developpeurs qui testent en parallele sur d'autres ports (8092/5183), pour
# ne jamais entrer en collision avec cette instance de production.
Write-Host "[3/5] Compilation..."
pnpm --filter @workspace/api-server run build | Out-Null
pnpm --filter @workspace/meteo-analyste run build | Out-Null
Write-Host "   OK."
Write-Host ""

# Etape 4 : Arret des anciens processus
Write-Host "[4/5] Arret des anciens processus..."
foreach ($port in @($apiPort, $webPort)) {
    try {
        $lines = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
        foreach ($line in $lines) {
            $procId = ($line -split '\s+')[-1]
            if ($procId -match '^\d+$' -and [int]$procId -gt 0) {
                Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
Start-Sleep -Seconds 2
Write-Host "   OK."
Write-Host ""

# Etape 5 : Demarrage
Write-Host "[5/5] Demarrage..."
Start-Process "cmd.exe" -ArgumentList "/k title API-Meteo && cd /d `"$project`" && pnpm --filter @workspace/api-server run start"

Write-Host "   Attente que l'API soit prete..."
$waited = 0
$ready = $false
while ($waited -lt 90) {
    Start-Sleep -Seconds 3
    $waited += 3
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $apiPort)
        $tcp.Close()
        $ready = $true
        break
    } catch {}
    Write-Host "   ...($waited s)"
}

if (-not $ready) {
    Write-Host ""
    Write-Host "ATTENTION : L'API ne repond pas sur le port $apiPort apres 90s."
    Write-Host "Verifiez la fenetre 'API-Meteo' pour voir l'erreur."
    Write-Host ""
} else {
    Write-Host "   API prete apres $waited s. OK."
}
Write-Host ""

Start-Process "cmd.exe" -ArgumentList "/k title Web-Meteo && cd /d `"$project`" && pnpm --filter @workspace/meteo-analyste run serve"
Write-Host "   Attente 5 secondes..."
Start-Sleep -Seconds 5
Write-Host ""

Write-Host "================================================"
Write-Host "  LOCAL  : http://localhost:$webPort"
Write-Host "  RESEAU : http://192.168.0.222:$webPort"
Write-Host "================================================"
Write-Host ""

Start-Process "http://localhost:$webPort"
Write-Host "Navigateur ouvert. Cette fenetre peut etre fermee."
Start-Sleep -Seconds 3
