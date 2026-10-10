; JinyuTV 安装程序脚本（NSIS 3.13）
;
; 为什么不用项目自带的 ElectroBun 打包：
;   它的构建链（Hutch → Cottontail → bun toolchain）必须从 GitHub Releases 拉工具链，
;   本机直连 GitHub 大文件会卡死（小请求正常，40MB 的包 150 秒下不完），
;   而 hutch 不支持配置国内镜像 —— 走不通。
;   这里直接用 NSIS 把已构建好的绿色版打成标准 Windows 安装程序。

Unicode true

!define APP_NAME      "JinyuTV"
!define APP_VERSION   "2.0.0"
!define APP_PUBLISHER "JinyuTV"
!define APP_EXE       "JinyuTV.exe"
!define APP_ID        "JinyuTV"

; 打包源目录：默认取仓库上一级的绿色版；由 build-installer.py 用
;   /DSOURCE_DIR=<净化后的暂存目录>
; 覆盖，以保证发行版不带打包机的账号与调试残留。
!ifndef SOURCE_DIR
  !define SOURCE_DIR "..\..\JinyuTV-portable"
!endif
!define ICON_FILE     "..\packages\assets\logo.ico"

Name "${APP_NAME}"
OutFile "..\..\JinyuTV-${APP_VERSION}-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

VIProductVersion "2.0.0.0"
VIAddVersionKey "ProductName"      "${APP_NAME}"
VIAddVersionKey "FileDescription"  "${APP_NAME} 安装程序"
VIAddVersionKey "FileVersion"      "${APP_VERSION}"
VIAddVersionKey "ProductVersion"   "${APP_VERSION}"
VIAddVersionKey "CompanyName"      "${APP_PUBLISHER}"
VIAddVersionKey "LegalCopyright"   "${APP_PUBLISHER}"

!include "MUI2.nsh"

!define MUI_ICON    "${ICON_FILE}"
!define MUI_UNICON  "${ICON_FILE}"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APP_NAME}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "主程序" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; 先关掉可能在运行的旧实例，避免文件占用
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM "bun.exe" /F'
  Pop $0

  ; 整个绿色版（含 runtime/bun.exe、build 产物、data）
  ; 排除 logs：运行中的日志文件会被服务占用，且没必要打进安装包
  File /r /x "logs" /x "*.log" "${SOURCE_DIR}\*.*"

  ; 应用图标（快捷方式与卸载项都用它）
  File "/oname=$INSTDIR\logo.ico" "${ICON_FILE}"

  ; 快捷方式
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"      "$INSTDIR\${APP_EXE}" "" "$INSTDIR\logo.ico" 0
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\logo.ico" 0
  CreateShortCut "$DESKTOP\${APP_NAME}.lnk"                     "$INSTDIR\${APP_EXE}" "" "$INSTDIR\logo.ico" 0

  ; 卸载信息（显示在「设置 → 应用」里）
  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName"     "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon"     "$INSTDIR\logo.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion"  "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher"       "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  nsExec::ExecToLog 'taskkill /IM "${APP_EXE}" /F'
  Pop $0
  nsExec::ExecToLog 'taskkill /IM "bun.exe" /F'
  Pop $0
  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  RMDir  "$SMPROGRAMS\${APP_NAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\${APP_ID}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
SectionEnd
