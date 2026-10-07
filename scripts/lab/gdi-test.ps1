# Standalone pipe client for the enotdesk-video helper (lab validation, ticket 02
# of the GDI-fallback run). Runs in ANY session (incl. SSH session 0): the helper
# itself must be started in the CONSOLE session (schtasks /it wrapper), the pipe
# works across sessions. Protocol per helper/video/README.md:
#   [u32 LE magic 'ENOT'][u8 type][u32 LE len][payload]
#   type 0 hello (client -> helper, first message), 1 frame (JPEG), 2 status (JSON).
# Saves the FIRST received frame as a JPEG and prints status documents so the
# mode field ("mode":"gdi") and fps are on record.

param(
  [Parameter(Mandatory = $true)][string]$Token,
  [int]$Seconds = 45,
  [string]$OutJpeg = "$env:TEMP\gdi-frame.jpg",
  [int]$MouseSweeps = 0,   # X1/X3: отправить N команд мыши {"cmd":"mouse"} по центру
  [int]$Probes = 0         # X3: отправить N команд {"cmd":"probe"} (rev-3)
)
$ErrorActionPreference = 'Stop'
$MAGIC = [uint32]0x454E4F54 # 'ENOT' little-endian

# Отправка command-кадра (type 3) в пайп: [magic][3][len][json]
function Send-Cmd($pipe, [string]$json) {
  $body = [System.Text.Encoding]::ASCII.GetBytes($json)
  $h = New-Object byte[] 9
  [Array]::Copy([BitConverter]::GetBytes($MAGIC), 0, $h, 0, 4)
  $h[4] = 3 # T_CMD
  [Array]::Copy([BitConverter]::GetBytes([uint32]$body.Length), 0, $h, 5, 4)
  $pipe.Write($h, 0, 9)
  $pipe.Write($body, 0, $body.Length)
  $pipe.Flush()
}

$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'enotdesk-video', [System.IO.Pipes.PipeDirection]::InOut)
try { $pipe.Connect(15000) } catch { Write-Output ("CONNECT-FAIL " + $_.Exception.Message); exit 2 }
Write-Output "CONNECTED"

$tok = [System.Text.Encoding]::ASCII.GetBytes($Token)
$hdr = New-Object byte[] 9
[Array]::Copy([BitConverter]::GetBytes($MAGIC), 0, $hdr, 0, 4)
$hdr[4] = 0 # T_HELLO
[Array]::Copy([BitConverter]::GetBytes([uint32]$tok.Length), 0, $hdr, 5, 4)
$pipe.Write($hdr, 0, 9)
$pipe.Write($tok, 0, $tok.Length)
$pipe.Flush()
Write-Output "HELLO-SENT"

# Фаза команд (X1/X3): мышь по центру + probe-команды (rev-3), с паузами.
if ($MouseSweeps -gt 0 -or $Probes -gt 0) {
  Start-Sleep -Milliseconds 800
  for ($i = 0; $i -lt $MouseSweeps; $i++) {
    $x = 0.4 + 0.2 * ($i % 2)   # 0.4 <-> 0.6 — зигзаг по центру
    # InvariantCulture: в ru-RU (-f) даёт "0,6" и ломает JSON (ожидается точка)
    $xs = $x.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    Send-Cmd $pipe ("{{`"cmd`":`"mouse`",`"x`":{0},`"y`":0.5,`"buttons`":`"move`"}}" -f $xs)
    Write-Output ("MOUSE-CMD " + $xs)
    Start-Sleep -Milliseconds 1200
  }
  for ($i = 0; $i -lt $Probes; $i++) {
    Send-Cmd $pipe '{"cmd":"probe"}'
    Write-Output "PROBE-CMD"
    Start-Sleep -Milliseconds 1500
  }
}

$acc = New-Object System.IO.MemoryStream
$chunk = New-Object byte[] 65536
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$frames = 0; $statuses = 0; $saved = $false; $lastStatus = ''; $seenGdi = $false

while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
  $n = 0
  try { $n = $pipe.Read($chunk, 0, $chunk.Length) }
  catch { Write-Output ("READ-ERR " + $_.Exception.Message); break }
  if ($n -le 0) { Start-Sleep -Milliseconds 30; continue }
  $acc.Write($chunk, 0, $n)
  $keep = $acc.ToArray()
  $pos = 0
  while ($true) {
    if ($keep.Length - $pos -lt 9) { break }
    if ([BitConverter]::ToUInt32($keep, $pos) -ne $MAGIC) { Write-Output 'BAD-MAGIC'; $pipe.Close(); exit 3 }
    $ty = $keep[$pos + 4]
    $len = [BitConverter]::ToUInt32($keep, $pos + 5)
    if ($keep.Length - $pos - 9 -lt $len) { break }
    $payload = New-Object byte[] $len
    [Array]::Copy($keep, $pos + 9, $payload, 0, $len)
    $pos += 9 + $len
    if ($ty -eq 1) {
      $frames++
      $fn = $OutJpeg -replace '\.jpg$', ('-{0:d3}.jpg' -f $frames)
      [System.IO.File]::WriteAllBytes($fn, $payload)
      if (-not $saved -and $seenGdi) {
        [System.IO.File]::WriteAllBytes($OutJpeg, $payload)
        $saved = $true
        Write-Output ("GDI-FRAME-SAVED " + $payload.Length + " bytes -> " + $OutJpeg)
      }
    }
    elseif ($ty -eq 2) {
      $statuses++
      $lastStatus = [System.Text.Encoding]::ASCII.GetString($payload)
      Write-Output ("STATUS " + $lastStatus)
      if ($lastStatus.Contains('"mode":"gdi"')) { $seenGdi = $true }
    }
  }
  $rest = New-Object byte[] ($keep.Length - $pos)
  [Array]::Copy($keep, $pos, $rest, 0, $rest.Length)
  $acc.SetLength(0)
  if ($rest.Length -gt 0) { $acc.Write($rest, 0, $rest.Length) }
}
try { $pipe.Close() } catch {}
Write-Output ("SUMMARY frames=" + $frames + " statuses=" + $statuses + " saved=" + $saved + " gdiSeen=" + $seenGdi)
if ($frames -gt 0 -and $saved -and $seenGdi) { exit 0 } else { exit 1 }
