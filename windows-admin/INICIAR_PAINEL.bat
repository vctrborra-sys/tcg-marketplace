@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo Execute INSTALAR_WINDOWS.bat primeiro. & pause & exit /b 1)
echo Painel TCG Marketplace: http://127.0.0.1:8765
echo Mantenha esta janela aberta enquanto deseja sincronizar.
start "" "http://127.0.0.1:8765/"
".venv\Scripts\python.exe" app.py start
pause
