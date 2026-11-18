@echo off
setlocal EnableExtensions
title Mappemonde 3D - arret du serveur

echo ============================================
echo   Mappemonde 3D - arret du serveur
echo ============================================
echo.

REM Trouve le PID qui ecoute sur le port 3456 et le tue
set "KILLED=0"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":3456 .*LISTENING"') do (
    echo Arret du serveur PID %%p sur le port 3456...
    taskkill /F /PID %%p >nul 2>&1
    set "KILLED=1"
)

echo.
if "%KILLED%"=="1" (
    echo Serveur arrete.
) else (
    echo Le serveur n'etait pas en marche sur le port 3456.
)

echo.
pause
endlocal
