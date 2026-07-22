# Installe Meteo Analyste dans le Planificateur de taches Windows
# A executer UNE SEULE FOIS en tant qu'Administrateur

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ps1Path = Join-Path $scriptDir "start-meteo.ps1"
$taskName = "MeteoAnalyste"

Write-Host ""
Write-Host "Installation de la tache automatique..."
Write-Host "Script : $ps1Path"
Write-Host ""

# Supprimer l'ancienne tache si elle existe
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

# Action : lancer start-meteo.ps1 via PowerShell
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Normal -File `"$ps1Path`""

# Declencheur : au demarrage de la machine (pas a l'ouverture de session) —
# une tache AtLogOn ne se relance jamais si personne ne se reconnecte apres
# un redemarrage du serveur ; AtStartup demarre l'app systematiquement, meme
# sans session ouverte.
$trigger = New-ScheduledTaskTrigger -AtStartup

# Parametres compatibles Windows Server 2019
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew

# LogonType S4U : execute la tache au demarrage sans session interactive et
# sans avoir a stocker de mot de passe (necessite le droit "Ouvrir une session
# en tant que tache par lots" pour ce compte, deja accorde par defaut en
# general). Les fenetres cmd de start-meteo.ps1 ne seront visibles que si une
# session $env:USERNAME s'ouvre ensuite, mais l'API et le frontend demarrent
# et ecoutent des le boot, sans attendre de connexion.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest

# Enregistrer la tache
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Lance Meteo Analyste automatiquement au demarrage du serveur" `
    -Force

Write-Host ""
Write-Host "================================================"
Write-Host "  SUCCES !"
Write-Host "  La tache '$taskName' est installee."
Write-Host "  L'application demarrera automatiquement"
Write-Host "  a chaque demarrage du serveur (meme sans connexion)."
Write-Host "================================================"
Write-Host ""

# V�rification
Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Appuyez sur une touche pour fermer..."
[Console]::ReadKey() | Out-Null