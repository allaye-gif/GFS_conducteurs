@echo off
title Web Meteo - Auto-restart
cd /d C:\Users\svrprevi\Desktop\Noaa\GFS_conducteurs
:loop
echo [%TIME%] Demarrage interface web...
pnpm --filter @workspace/meteo-analyste run dev
echo.
echo [%TIME%] Web arrete - redemarrage dans 5 secondes...
timeout /t 5 /nobreak > nul
goto loop
