@echo off
setlocal
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"
if not exist "%EXE%" (
  echo Missing Electron. This launcher does not install dependencies.
  pause
  exit /b 1
)
if not exist "%APP%\asr\Release\whisper-server.exe" (
  echo Missing local speech runtime.
  pause
  exit /b 1
)
if not exist "%APP%\asr\ggml-small.bin" (
  echo Missing local speech model.
  pause
  exit /b 1
)
if not exist "%APP%\ocr-runtime\python\python.exe" (
  echo Missing local OCR runtime. Run scripts\prepare-ocr-runtime.ps1 first.
  pause
  exit /b 1
)
if not exist "%APP%\ocr-runtime\runtime-manifest.json" (
  echo OCR preparation has not completed. See scripts\prepare-ocr-runtime.ps1.
  pause
  exit /b 1
)
set "PPT_AI_PREVIEW_DATA=%ROOT%work\internal-preview-profile"
set "TEMP=%ROOT%work\internal-preview-tmp"
set "TMP=%TEMP%"
if not exist "%PPT_AI_PREVIEW_DATA%" mkdir "%PPT_AI_PREVIEW_DATA%"
if not exist "%TEMP%" mkdir "%TEMP%"
set "ELECTRON_RUN_AS_NODE="
start "" /D "%APP%" "%EXE%" "%APP%"
exit /b 0
