@echo off
chcp 65001 >nul 2>&1
echo.
echo  ========================================
echo    Meteo Analyste - Mise a jour
echo  ========================================
echo.

echo  Reinitialisation des fichiers auto-generes...
git checkout -- pnpm-lock.yaml >nul 2>&1
git checkout -- package-lock.json >nul 2>&1
echo.

echo  Recuperation des mises a jour GitHub...
git pull origin main
echo.

echo  Installation des dependances...
call pnpm install
echo.

echo  Compilation des modules natifs (ssh2)...
call pnpm rebuild cpu-features ssh2 >nul 2>&1
echo.

echo  Mise a jour terminee !
echo  Les serveurs se rechargent automatiquement.
echo  (patientez 5 secondes puis rafraichissez le navigateur)
echo.
pause
