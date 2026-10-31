Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!define PRODUCT_NAME "VC Mix"
!define PRODUCT_URL "https://github.com/RobertTGreat/VC-Mix"
!define DEFAULT_DIRECTORY "__VC_MIX_DEFAULT__"
!ifdef TEST_INSTALLER
  RequestExecutionLevel user
  !define REGISTRY_ROOT HKCU
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VCMixInstallerTest"
!else
  RequestExecutionLevel admin
  !define REGISTRY_ROOT HKLM
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\VCMix"
!endif

Name "${PRODUCT_NAME}"
OutFile "${OUTPUT_PATH}"
InstallDir "${DEFAULT_DIRECTORY}"
!ifdef TEST_INSTALLER
  SetCompressor /SOLID zlib
!else
  SetCompressor /SOLID lzma
  SetCompressorDictSize 32
!endif
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "VC Mix OBS plugin installer"
VIAddVersionKey /LANG=1033 "LegalCopyright" "VC Mix contributors"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Capture Discord participants as separate OBS audio sources.$\r$\n$\r$\nClose OBS Studio before continuing. VC Mix will be installed in OBS's standard Windows plugin directory."
!define MUI_FINISHPAGE_TEXT "VC Mix is installed.$\r$\n$\r$\nOpen OBS Studio and choose Tools > VC Mix to configure your bot and add participant sources."
!define MUI_FINISHPAGE_LINK "VC Mix setup instructions"
!define MUI_FINISHPAGE_LINK_LOCATION "${PRODUCT_URL}#connect-discord"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

!macro DefinePathValidation PREFIX
Function ${PREFIX}ValidateDirectory
  ; Unlike NSIS GetFullPathName, the Windows API also resolves destinations that do not exist yet.
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  StrCpy $INSTDIR $1
  ${GetFileName} "$INSTDIR" $0
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $0 != "vc-mix"
    MessageBox MB_OK|MB_ICONSTOP "The plugin destination must be a folder named vc-mix." /SD IDOK
    SetErrorLevel 123
    Quit
  ${EndIf}
FunctionEnd
!macroend
!insertmacro DefinePathValidation ""
!insertmacro DefinePathValidation "un."

!macro DefineLibraryCheck PREFIX
Function ${PREFIX}RequireWritableLibrary
  Exch $0
  Push $1
  IfFileExists "$0" 0 library_ready
  System::Call 'kernel32::CreateFileW(w r0, i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r1'
  ${If} $1 == -1
    MessageBox MB_OK|MB_ICONSTOP "Close OBS Studio and run setup again. The plugin is in use or its folder is not writable." /SD IDOK
    SetErrorLevel 32
    Quit
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r1)'
library_ready:
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro DefineLibraryCheck ""
!insertmacro DefineLibraryCheck "un."

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "VC Mix requires 64-bit Windows." /SD IDOK
    SetErrorLevel 193
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "VC Mix requires Windows 10 or newer." /SD IDOK
    SetErrorLevel 1150
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext all
  ; Resolve ProgramData after setting the shell context; preserve an explicit /D destination.
  ${If} $INSTDIR == "${DEFAULT_DIRECTORY}"
    !ifdef TEST_INSTALLER
      StrCpy $INSTDIR "$EXEDIR\plugins\vc-mix"
    !else
      StrCpy $INSTDIR "$APPDATA\obs-studio\plugins\vc-mix"
    !endif
  ${EndIf}
  Call ValidateDirectory
  Push "$INSTDIR\bin\64bit\vc-mix.dll"
  Call RequireWritableLibrary
  ${GetParent} "$INSTDIR" $0
  Push "$0\discord-voice\bin\64bit\discord-voice.dll"
  Call RequireWritableLibrary
FunctionEnd

Section "VC Mix" MainSection
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r "${PAYLOAD_DIR}\*.*"
  WriteINIStr "$INSTDIR\install.ini" "Product" "Name" "${PRODUCT_NAME}"
  WriteINIStr "$INSTDIR\install.ini" "Product" "Version" "${PRODUCT_VERSION}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ; Retire the previous module only after the new payload has been installed.
  ${GetParent} "$INSTDIR" $0
  IfFileExists "$0\discord-voice\bin\64bit\discord-voice.dll" 0 legacy_finished
  Delete "$0\discord-voice\bin\64bit\discord-voice.dll.disabled-vc-mix"
  ClearErrors
  Rename "$0\discord-voice\bin\64bit\discord-voice.dll" "$0\discord-voice\bin\64bit\discord-voice.dll.disabled-vc-mix"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "VC Mix was copied, but the previous plugin could not be disabled. Close OBS and run setup again." /SD IDOK
    SetErrorLevel 29
    Quit
  ${EndIf}
legacy_finished:
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "Publisher" "VC Mix contributors"
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_URL}"
  WriteRegDWORD ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD ${REGISTRY_ROOT} "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext all
  Call un.ValidateDirectory
  ReadINIStr $0 "$INSTDIR\install.ini" "Product" "Name"
  ${If} $0 != "${PRODUCT_NAME}"
    MessageBox MB_OK|MB_ICONSTOP "This folder is not a VC Mix installation. No files were removed." /SD IDOK
    SetErrorLevel 13
    Quit
  ${EndIf}
  Push "$INSTDIR\bin\64bit\vc-mix.dll"
  Call un.RequireWritableLibrary
FunctionEnd

Section "Uninstall"
  ; ValidateDirectory and install.ini restrict deletion to this product's own named directory.
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\data"
  RMDir /r "$INSTDIR\docs"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\install.ini"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey ${REGISTRY_ROOT} "${UNINSTALL_KEY}"
  ; User configuration belongs to OBS and survives uninstall.
SectionEnd
