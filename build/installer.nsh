; EnotDesk: service lifecycle during install / update / uninstall.
; The EnotDeskAgent service keeps EnotDesk.exe (from the install dir) running
; around the clock, so:
;   - before copying files we stop it with `sc stop` -- a CLEAN stop: the SCM
;     treats it as intentional and does not restart the service mid-install.
;     Killing the process alone made the SCM relaunch the agent (failure
;     actions 5s/10s/30s) and race the installer for file locks (finding
;     10.10.2026: quit-install updates could fail on a slow disk);
;   - after copying we start it back up -- but only if the service actually
;     exists: on a fresh install it is not created by the installer, it is
;     created from the client UI ("Machine (persistent access)", ADR 0029);
;   - on uninstall we stop the agent and delete the service registration,
;     otherwise a service pointing into a deleted directory stays registered.
; Hooks are the documented electron-builder extension points (installer.nsi,
; installSection.nsh, uninstaller.nsh). ASCII-only text: this file is compiled
; into both the installer and the uninstaller and input encoding is not
; guaranteed.
; External tools are always invoked by absolute path ($SYSDIR): nsExec hands the
; command line to CreateProcess, which resolves bare names against the caller's
; directory first -- an elevated installer launched from a user-writable folder
; (e.g. Downloads) must never execute a planted binary (security review
; 10.10.2026). nsExec does not expand %VAR%, so $SYSDIR (NSIS system-dir
; constant) is used; on x64 a 32-bit installer resolves it to SysWOW64, where
; sc.exe and taskkill.exe also exist.

!macro edStopAgentAndAwait
  Push $R0
  Push $R1
  nsExec::Exec "$SYSDIR\sc.exe stop EnotDeskAgent"
  Pop $R1
  nsExec::Exec "$SYSDIR\taskkill.exe /F /IM EnotDesk.exe /T"
  Pop $R1
  ; Wait until the exe is free (up to 30 x 500ms): sc stop is async, the
  ; service process may take a moment to exit. Probe = open the exe for
  ; write; for a running process that fails with a sharing violation.
  StrCpy $R0 0
ed_wait:
  IfFileExists "$INSTDIR\EnotDesk.exe" 0 ed_unlocked
  System::Call 'kernel32::CreateFile(t "$INSTDIR\EnotDesk.exe", i 1073741824, i 0, i 0, i 3, i 0, i 0) p.R1'
  System::Call 'kernel32::CloseHandle(p R1)'
  IntCmp $R1 -1 0 ed_unlocked ed_unlocked
  nsExec::Exec "$SYSDIR\taskkill.exe /F /IM EnotDesk.exe /T"
  Pop $R1
  Sleep 500
  IntOp $R0 $R0 + 1
  IntCmp $R0 30 ed_unlocked ed_wait ed_unlocked
ed_unlocked:
  Pop $R1
  Pop $R0
!macroend

!macro customInit
  DetailPrint "EnotDesk: stopping EnotDeskAgent service for the install"
  !insertmacro edStopAgentAndAwait
!macroend

!macro customInstall
  Push $R1
  ; ADR 0029: the service is created by the client UI, not by the installer,
  ; so on a fresh install it does not exist (sc query returns 1060) -- skip
  nsExec::Exec "$SYSDIR\sc.exe query EnotDeskAgent"
  Pop $R1
  IntCmp $R1 0 0 ed_no_agent ed_no_agent
  nsExec::Exec "$SYSDIR\sc.exe start EnotDeskAgent"
  Pop $R1
ed_no_agent:
  Pop $R1
!macroend

!macro customUnInstall
  Push $R0
  DetailPrint "EnotDesk: stopping and removing EnotDeskAgent service"
  nsExec::Exec "$SYSDIR\sc.exe stop EnotDeskAgent"
  Pop $R0
  nsExec::Exec "$SYSDIR\taskkill.exe /F /IM EnotDesk.exe /T"
  Pop $R0
  ; pause so the service exits before delete (sc stop is async)
  Sleep 1500
  nsExec::Exec "$SYSDIR\sc.exe delete EnotDeskAgent"
  Pop $R0
!macroend