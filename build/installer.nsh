; Override electron-builder's default "app running" check.
; Default uses substring find.exe matching and can false-positive,
; then loop forever on "无法关闭" even when SimplyGo.exe is not running.
!macro customCheckAppRunning
  DetailPrint "Closing ${APP_EXECUTABLE_FILENAME} if running..."
  StrCpy $R1 0

  kill_loop:
    nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /T`
    nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /IM "JianXingBrowser.exe" /T`
    Sleep 600

    ; Exact image-name match only (no substring false positives)
    nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    Pop $R2

    ${If} $R0 == 0
      IntOp $R1 $R1 + 1
      ${If} $R1 < 4
        DetailPrint "Waiting for ${APP_EXECUTABLE_FILENAME} to exit ($R1)..."
        Sleep 1000
        Goto kill_loop
      ${EndIf}
      ; Still reported running after force-kill — do not block install
      DetailPrint "Could not confirm process exit; continuing install."
    ${EndIf}
!macroend

!macro customInstall
  DetailPrint "Registering SimplyGo as a web browser..."
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo" "" "简行浏览器"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities" "ApplicationName" "简行浏览器"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities" "ApplicationDescription" "面向家庭的青少年浏览器"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities\URLAssociations" "http" "SimplyGoHTML"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities\URLAssociations" "https" "SimplyGoHTML"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities\FileAssociations" ".htm" "SimplyGoHTML"
  WriteRegStr HKLM "Software\Clients\StartMenuInternet\SimplyGo\Capabilities\FileAssociations" ".html" "SimplyGoHTML"
  WriteRegStr HKLM "Software\RegisteredApplications" "SimplyGo" "Software\Clients\StartMenuInternet\SimplyGo\Capabilities"
  WriteRegStr HKLM "Software\Classes\SimplyGoHTML" "" "简行浏览器 HTML 文档"
  WriteRegStr HKLM "Software\Classes\SimplyGoHTML" "URL Protocol" ""
  WriteRegStr HKLM "Software\Classes\SimplyGoHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKLM "Software\Classes\SimplyGoHTML\Application" "ApplicationName" "简行浏览器"
  WriteRegStr HKLM "Software\Classes\SimplyGoHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  DeleteRegKey HKLM "Software\Clients\StartMenuInternet\JianXingBrowser"
  DeleteRegValue HKLM "Software\RegisteredApplications" "JianXingBrowser"
  DeleteRegKey HKLM "Software\Classes\JianXingBrowserHTML"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\JianXingBrowser"
  DeleteRegValue HKCU "Software\RegisteredApplications" "JianXingBrowser"
  DeleteRegKey HKCU "Software\Classes\JianXingBrowserHTML"
!macroend

!macro customUnInstall
  DeleteRegKey HKLM "Software\Clients\StartMenuInternet\SimplyGo"
  DeleteRegValue HKLM "Software\RegisteredApplications" "SimplyGo"
  DeleteRegKey HKLM "Software\Classes\SimplyGoHTML"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\SimplyGo"
  DeleteRegValue HKCU "Software\RegisteredApplications" "SimplyGo"
  DeleteRegKey HKCU "Software\Classes\SimplyGoHTML"
  DeleteRegKey HKLM "Software\Clients\StartMenuInternet\JianXingBrowser"
  DeleteRegValue HKLM "Software\RegisteredApplications" "JianXingBrowser"
  DeleteRegKey HKLM "Software\Classes\JianXingBrowserHTML"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\JianXingBrowser"
  DeleteRegValue HKCU "Software\RegisteredApplications" "JianXingBrowser"
  DeleteRegKey HKCU "Software\Classes\JianXingBrowserHTML"
!macroend
