@echo off
title API Meteo - Auto-restart
cd /d C:\Users\svrprevi\Desktop\Noaa\GFS_conducteurs
:loop
echo [%TIME%] Demarrage serveur API...
pnpm --filter @workspace/api-server run dev
echo.
echo [%TIME%] API arretee - redemarrage dans 5 secondes...
timeout /t 5 /nobreak > nul
goto loop
