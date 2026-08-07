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

echo  Recuperation, compilation et redemarrage complet...
echo  (delegue a start.bat pour ne jamais servir un build perime :
echo   la mise a jour du code seule ne suffit pas en production, il
echo   faut aussi recompiler dist/ et relancer les process)
echo.
call "%~dp0start.bat"
