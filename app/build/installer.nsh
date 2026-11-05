; Build-time inputs are prepared by scripts/prepare-build.ps1.
!include "MUI2.nsh"
!include "WordFunc.nsh"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  !define MUI_PAGE_HEADER_TEXT "隐私说明"
  !define MUI_PAGE_HEADER_SUBTEXT "请阅读本机处理、外部请求与配置保存说明。"
  !insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}\build\generated\PRIVACY.txt"
!macroend

!macro PPTInstallRuntime
  ; Per-machine install is already elevated. A newer v14 runtime is preserved.
  StrCpy $1 0
  StrCpy $2 ""
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" Installed
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" Version
  StrCpy $3 $2 1
  ${If} $3 == "v"
    StrCpy $2 $2 "" 1
  ${EndIf}
  ${VersionCompare} "$2" "14.51.36247.0" $3
  ${If} $1 != 1
  ${OrIf} $3 == 2
    InitPluginsDir
    File /oname=$PLUGINSDIR\VC_redist.x64.exe "${PROJECT_DIR}\build\vendor\VC_redist.x64.exe"
    DetailPrint "正在准备 Microsoft Visual C++ 运行库，请稍候……"
    ExecWait '"$PLUGINSDIR\VC_redist.x64.exe" /install /quiet /norestart /log "$PLUGINSDIR\vc-redist-install.log"' $4
    ${If} $4 == 3010
      SetRebootFlag true
    ${ElseIf} $4 != 0
      ; 1638 is acceptable only when registry proves a suitable newer runtime.
      StrCpy $1 0
      StrCpy $2 ""
      ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" Installed
      ReadRegStr $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" Version
      StrCpy $5 $2 1
      ${If} $5 == "v"
        StrCpy $2 $2 "" 1
      ${EndIf}
      ${VersionCompare} "$2" "14.51.36247.0" $3
      ${If} $1 != 1
      ${OrIf} $3 == 2
        MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ 运行库安装未完成（代码 $4）。请保存工作、重启电脑后重试。"
        Abort
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ; This hook runs before uninstallOldVersion, after the user starts installation.
  ; The helper verifies the exact executable/script paths, not generic process names.
  !ifndef BUILD_UNINSTALLER
    !insertmacro PPTInstallRuntime
  !endif
  InitPluginsDir
  File /oname=$PLUGINSDIR\ppt-ai-install-cleanup.ps1 "${PROJECT_DIR}\build\install-cleanup.ps1"
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  nsExec::ExecToLog /TIMEOUT=90000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ppt-ai-install-cleanup.ps1" -InstallRoot "$INSTDIR" -RegisteredMachineRoot "$0" -RegisteredUserRoot "$1"'
  Pop $2
  ${If} $2 != 0
    MessageBox MB_OK|MB_ICONSTOP "无法安全关闭旧版或备份安装目录中的素材。请用 Ctrl+Alt+Q 退出 PPT-AI，将个人文件移出安装目录后重试。"
    Abort
  ${EndIf}
!macroend

!macro customRemoveFiles
  ; Never recursively erase arbitrary user files from the application root.
  ; Application-owned runtime/resource directories are removed explicitly.
  SetOutPath $TEMP
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\NOTICE.txt"
  Delete "$INSTDIR\PRIVACY.md"
  Delete "$INSTDIR\PRIVACY.txt"
  Delete "$INSTDIR\uninstallerIcon.ico"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  RMDir /r "$INSTDIR\third-party-licenses"
  RMDir "$INSTDIR"
!macroend
