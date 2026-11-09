@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo Instale primeiro com INSTALAR_WINDOWS.bat. & pause & exit /b 1)
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if not exist "%STARTUP%" (echo Pasta Startup nao encontrada. & pause & exit /b 1)
> "%STARTUP%\TCG Marketplace.cmd" echo @echo off
>> "%STARTUP%\TCG Marketplace.cmd" echo call "%~dp0INICIAR_PAINEL.bat"
if errorlevel 1 (echo Falha ao criar inicializacao. & pause & exit /b 1)
echo Inicio automatico ativado ao entrar no Windows.
echo Para remover, use Win+R, shell:startup, e apague TCG Marketplace.cmd.
pause
