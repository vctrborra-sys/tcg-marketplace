@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
if not exist ".venv\Scripts\python.exe" (
  echo O instalador ainda nao terminou. Primeiro execute INSTALAR_WINDOWS.bat.
  pause
  exit /b 1
)
echo ===========================================
echo TCG MARKETPLACE - RECUPERACAO DA SENHA ADMIN
echo ===========================================
".venv\Scripts\python.exe" app.py reset-admin
if errorlevel 1 (
  echo.
  echo Nao foi possivel completar. Verifique o erro acima.
)
echo.
pause
