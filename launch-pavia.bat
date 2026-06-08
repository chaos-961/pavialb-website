@echo off
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

set "PORT=8000"

for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  taskkill /pid %%P /f >nul 2>&1
)

powershell -NoProfile -Command "Start-Process -FilePath 'py' -ArgumentList '-m','http.server','%PORT%','--bind','127.0.0.1','--directory','%ROOT%' -WorkingDirectory '%ROOT%' -WindowStyle Hidden"
ping 127.0.0.1 -n 3 >nul

set "STAMP=%RANDOM%%RANDOM%"
start "" "http://127.0.0.1:%PORT%/?dev=%STAMP%"
start "" "http://127.0.0.1:%PORT%/admin/?dev=%STAMP%"
