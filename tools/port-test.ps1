# Finds which ports on this PC can be reached from the internet.
# Run in PowerShell as Administrator:
#   powershell -ExecutionPolicy Bypass -File tools\port-test.ps1
# Then, from a phone on MOBILE DATA (Wi-Fi off), open http://<public-ip>:<port> for each port listed.
# A page saying "PORT xxxx IS OPEN" means that port works from outside. Press Ctrl+C to stop;
# the temporary listeners and firewall rule are removed automatically.

$ports = 80, 81, 443, 3000, 3001, 5000, 8000, 8001, 8008, 8081, 8082, 8088, 8090, 8181, 8443, 8888, 9000, 9090
$ruleName = 'ABCDryBASIN PORT TEST (temporary)'

$listeners = @()
foreach ($p in $ports) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $p)
    $l.Start()
    $listeners += $l
    Write-Host "  listening on $p"
  } catch {
    Write-Host "  skip $p (already used by another program on this PC)" -ForegroundColor DarkGray
  }
}

New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort ($listeners | ForEach-Object { $_.LocalEndpoint.Port }) -Action Allow | Out-Null

Write-Host ''
Write-Host 'Now test from a phone on mobile data, e.g. http://41.229.139.17:8081' -ForegroundColor Cyan
Write-Host 'Every request that reaches this PC is printed below in green. Ctrl+C to stop.' -ForegroundColor Cyan
Write-Host ''

try {
  while ($true) {
    foreach ($l in $listeners) {
      while ($l.Pending()) {
        $client = $l.AcceptTcpClient()
        $port = $l.LocalEndpoint.Port
        Write-Host ("  REACHED: port {0}  from {1}" -f $port, $client.Client.RemoteEndPoint) -ForegroundColor Green
        try {
          $stream = $client.GetStream()
          Start-Sleep -Milliseconds 100
          $body = "PORT $port IS OPEN"
          $resp = "HTTP/1.1 200 OK`r`nContent-Type: text/plain`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body"
          $bytes = [System.Text.Encoding]::ASCII.GetBytes($resp)
          $stream.Write($bytes, 0, $bytes.Length)
        } catch {}
        $client.Close()
      }
    }
    Start-Sleep -Milliseconds 200
  }
} finally {
  $listeners | ForEach-Object { $_.Stop() }
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host 'Stopped and cleaned up.'
}
