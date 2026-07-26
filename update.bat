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
:: HP developpe sur "master", svrprevi tourne sur "main" (historique git
:: separe a l'origine) - sur main on fusionne master automatiquement pour ne
:: jamais avoir a le faire a la main.
git fetch origin
for /f %%b in ('git rev-parse --abbrev-ref HEAD') do set CURRENT_BRANCH=%%b
if /i "%CURRENT_BRANCH%"=="main" (
    git merge origin/master -m "merge master into main"
    git push origin main
) else (
    git merge "origin/%CURRENT_BRANCH%"
)
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
