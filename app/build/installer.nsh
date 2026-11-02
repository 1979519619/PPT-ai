; Show the shipped privacy statement in the assisted installer.
!include "MUI2.nsh"
!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}\..\PRIVACY.md"
!macroend
