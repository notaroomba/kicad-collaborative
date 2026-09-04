; NSIS installer for KiCad Collaborative (built in CI from an MSYS2 tree).
;
; Installs into its own directory with its own Start Menu entry and
; uninstaller, deliberately NOT registering .kicad_* file associations:
; it lives alongside a stock KiCad install and must not capture its files.

!include "MUI2.nsh"
!include "x64.nsh"

!ifndef VERSION
  !define VERSION "10.99"
!endif
!ifndef STAGEDIR
  !define STAGEDIR "stage"
!endif

Name "KiCad Collaborative ${VERSION}"
OutFile "KiCad-Collaborative-${VERSION}-windows-x64.exe"
Unicode true
InstallDir "$PROGRAMFILES64\KiCad Collaborative"
InstallDirRegKey HKLM "Software\KiCad Collaborative" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\bin\kicad.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "KiCad Collaborative"
  SetOutPath "$INSTDIR"
  File /r "${STAGEDIR}\*.*"

  WriteRegStr HKLM "Software\KiCad Collaborative" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Register the kicad-collab:// URL scheme (the web "Open in KiCad
  ; Collaborative" button) to launch the project manager with the link.
  WriteRegStr HKCR "kicad-collab" "" "URL:KiCad Collaborative Protocol"
  WriteRegStr HKCR "kicad-collab" "URL Protocol" ""
  WriteRegStr HKCR "kicad-collab\DefaultIcon" "" "$INSTDIR\bin\kicad.exe,0"
  WriteRegStr HKCR "kicad-collab\shell\open\command" "" '"$INSTDIR\bin\kicad.exe" "%1"

  CreateDirectory "$SMPROGRAMS\KiCad Collaborative"
  CreateShortcut "$SMPROGRAMS\KiCad Collaborative\KiCad Collaborative.lnk" "$INSTDIR\bin\kicad.exe"
  CreateShortcut "$SMPROGRAMS\KiCad Collaborative\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "DisplayName" "KiCad Collaborative ${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "DisplayIcon" "$INSTDIR\bin\kicad.exe"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative" \
      "NoRepair" 1
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR"
  RMDir /r "$SMPROGRAMS\KiCad Collaborative"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiCadCollaborative"
  DeleteRegKey HKCR "kicad-collab"
  DeleteRegKey HKLM "Software\KiCad Collaborative"
SectionEnd
