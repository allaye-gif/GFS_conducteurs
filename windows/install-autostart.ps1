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

# Declencheur : a chaque ouverture de session
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Parametres
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable $true

# Enregistrer la tache
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -RunLevel Highest `
    -Description "Lance Meteo Analyste automatiquement au demarrage de session Windows" `
    -Force

Write-Host ""
Write-Host "================================================"
Write-Host "  SUCCES !"
Write-Host "  La tache '$taskName' est installee."
Write-Host "  L'application demarrera automatiquement"
Write-Host "  a chaque connexion Windows."
Write-Host "================================================"
Write-Host ""
Write-Host "Appuyez sur une touche pour fermer..."
[Console]::ReadKey() | Out-Null
