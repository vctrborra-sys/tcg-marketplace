@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  set "PY=python"
)
echo ==============================
echo   INSTALACAO TCG MARKETPLACE
 echo ==============================
%PY% --version
if errorlevel 1 (
  echo ERRO: instale Python 3.11+ de https://www.python.org/downloads/windows/
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" %PY% -m venv .venv
if errorlevel 1 (echo Falha ao criar ambiente virtual. & pause & exit /b 1)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (echo Instale conectado a Internet e tente novamente. & pause & exit /b 1)
".venv\Scripts\python.exe" app.py setup
echo.
echo INSTALADO. Abra CONFIGURAR_GITHUB.bat para sincronizar automaticamente.
echo Depois use INICIAR_PAINEL.bat.
pause
