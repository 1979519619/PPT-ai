@echo off
setlocal
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo Electron is not installed in the new workspace.
  echo Prepare dependencies in app before launching.
  pause
  exit /b 1
)
if not exist "%APP%\asr\Release\whisper-server.exe" (
  echo Missing local ASR runtime: app\asr\Release\whisper-server.exe
  pause
  exit /b 1
)
if not exist "%APP%\asr\ggml-small.bin" (
  echo Missing local ASR model: app\asr\ggml-small.bin
  pause
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
start "" "%EXE%" "%APP%"
exit /b 0
