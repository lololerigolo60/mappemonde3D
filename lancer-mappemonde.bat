@echo off
setlocal EnableExtensions
title Mappemonde 3D

REM %~dp0 = dossier du .bat (ici: ...\mappemonde\)
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

echo ============================================
echo   Mappemonde 3D - lancement
echo ============================================
echo.

REM 1) Node.js disponible ?
where node >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Node.js introuvable dans le PATH.
    echo Installe-le depuis https://nodejs.org puis relance.
    echo.
    pause
    exit /b 1
)

REM 2) Le port 3456 est-il deja occupe (serveur deja en marche) ?
REM     On ne compte que l'etat LISTENING, pas les TIME_WAIT/SYN_SENT residuels.
netstat -ano | findstr /R /C:":3456 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo Le serveur semble deja en marche sur le port 3456.
    echo J'ouvre la page dans le navigateur...
    echo.
    start "" http://127.0.0.1:3456
    pause
    exit /b 0
)

REM 3) Cles API  (parentheses echappees : ^)  a l'interieur des blocs if/else)
if defined AISSTREAM_API_KEY (
    echo [OK] Cles AIS aisstream.io presente  [variable AISSTREAM_API_KEY].
) else (
    if exist "%APP_DIR%.aisstream_key" (
        echo [OK] Cles AIS aisstream.io trouvee dans .aisstream_key.
    ) else (
        echo [INFO] Cles AIS aisstream.io absente : le flux navires restera vide.
        echo        Defini la variable d'environnement AISSTREAM_API_KEY,
        echo        ou cree un fichier .aisstream_key dans ce dossier.
        echo        Cle gratuite : https://aisstream.io
    )
)

REM 4) Identifiants OpenSky OAuth2 presentes ?
if exist "%APP_DIR%.opensky_credentials.json" (
    echo [OK] Identifiants OpenSky OAuth2 trouves dans .opensky_credentials.json.
) else (
    echo [INFO] Identifiants OpenSky OAuth2 absents : quota anonyme 400 credits/jour.
    echo        Cree un fichier .opensky_credentials.json avec clientId et clientSecret.
)

REM 5) Petit delai puis ouverture du navigateur (ping = delai fiable, pas de souci de redirection)
ping -n 2 127.0.0.1 >nul
start "" http://127.0.0.1:3456

echo Demarrage du serveur sur http://127.0.0.1:3456 ...
echo proxy vols OpenSky : /api/flights   -   flux navires AIS : /api/ships
echo Appuie sur Ctrl+C ou ferme cette fenetre pour arreter.
echo.
node server.js

REM 6) Serveur arrete -> on garde la fenetre ouverte pour lire le message
echo.
echo Le serveur s'est arrete.
pause
endlocal
