@echo off
rem Double-click to start Shorts Factory (Docker Desktop must be installed).
cd /d "%~dp0"
docker info >nul 2>&1
if not errorlevel 1 goto ready
echo Starting Docker Desktop, please wait...
start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
:wait
timeout /t 5 /nobreak >nul
docker info >nul 2>&1
if errorlevel 1 goto wait
:ready
rem Starts the app and worker (plus database and Redis). The free local AI (Ollama) is only
rem needed when Settings uses it: then run "docker compose up -d" instead.
docker compose up -d app worker
if errorlevel 1 goto failed
echo.
echo Shorts Factory is running. Opening http://localhost:3000 ...
timeout /t 5 /nobreak >nul
start "" http://localhost:3000
exit /b 0
:failed
echo.
echo Starting failed - see the error above.
pause
exit /b 1
