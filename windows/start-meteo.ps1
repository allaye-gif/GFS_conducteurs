$project = "C:\Users\svrprevi\Desktop\Noaa\GFS_conducteurs"
$apiPort = 8091
$webPort = 3001

Write-Host ""
Write-Host "================================================"
Write-Host "     METEO ANALYSTE - Demarrage"
Write-Host "================================================"
Write-Host ""

# Etape 1 : Tuer les anciens processus
Write-Host "[1/3] Arret des anciens processus..."
foreach ($port in @($apiPort, $webPort)) {
    try {
        $lines = netstat -ano | Select-String ":$port\s" | Select-String "LISTENING"
        foreach ($line in $lines) {
            $pid = ($line -split '\s+')[-1]
            if ($pid -match '^\d+$' -and [int]$pid -gt 0) {
                Stop-Process -Id ([int]$pid) -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
Start-Sleep -Seconds 2
Write-Host "   OK."
Write-Host ""

# Etape 2 : Demarrer l'API
Write-Host "[2/3] Demarrage API sur port $apiPort..."
Start-Process "cmd.exe" -ArgumentList "/k title API-Meteo && cd /d `"$project`" && pnpm --filter @workspace/api-server run dev"

# Attendre que le port 8091 soit reellement ouvert (max 90s)
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
    Write-Host "Appuyez sur une touche pour continuer quand meme..."
    [Console]::ReadKey() | Out-Null
} else {
    Write-Host "   API prete apres $waited s. OK."
}
Write-Host ""

# Etape 3 : Demarrer le frontend
Write-Host "[3/3] Demarrage interface web sur port $webPort..."
Start-Process "cmd.exe" -ArgumentList "/k title Web-Meteo && cd /d `"$project`" && pnpm --filter @workspace/meteo-analyste run dev"
Write-Host "   Attente 10 secondes..."
Start-Sleep -Seconds 10
Write-Host ""

Write-Host "================================================"
Write-Host "  LOCAL  : http://localhost:$webPort"
Write-Host "  RESEAU : http://192.168.0.222:$webPort"
Write-Host "================================================"
Write-Host ""

Start-Process "http://localhost:$webPort"
Write-Host "Navigateur ouvert. Cette fenetre peut etre fermee."
Start-Sleep -Seconds 3
