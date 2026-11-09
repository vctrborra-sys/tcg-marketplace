@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar-acesso-remoto.ps1"
set "MARKETPLACE_RESULT=%ERRORLEVEL%"
pause
exit /b %MARKETPLACE_RESULT%
