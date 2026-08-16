# cdp-shot.ps1 — drive headless Edge via CDP to open the DSH web GUI,
# click the 用量 tab, wait for the token chart, and capture a screenshot.
# Usage: pwsh cdp-shot.ps1 [-Port 9223] [-Out screenshot.png] [-Url http://127.0.0.1:3080]
param(
  [int]$Port = 9223,
  [string]$Out = 'E:\dsh\dsh-token-ledger\scripts\shots\usage-view.png',
  [string]$Url = 'http://127.0.0.1:3080'
)

$ErrorActionPreference = 'Stop'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$profile = Join-Path (Split-Path $Out) 'edge-profile'
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

# 1) launch headless Edge with remote debugging
$proc = Start-Process $edge -ArgumentList @(
  '--headless=new','--disable-gpu','--no-first-run','--disable-extensions',
  "--remote-debugging-port=$Port", "--user-data-dir=$profile", 'about:blank'
) -PassThru -WindowStyle Hidden
Write-Host "edge pid: $($proc.Id)"

try {
  # 2) wait for the debugging endpoint
  $target = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $list = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
      $target = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
      if ($target) { break }
    } catch { }
  }
  if (-not $target) { throw 'no CDP page target' }
  Write-Host "target: $($target.url)  ws: $($target.webSocketDebuggerUrl.Substring(0,40))..."

  # 3) WebSocket client
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  $nextId = 0
  $pending = @{}
  $readBuf = New-Object byte[] 262144

  function Receive-Loop([int]$waitId, [int]$timeoutMs = 60000) {
    $deadline = [Environment]::TickCount64 + $timeoutMs
    while ($true) {
      if ($pending.ContainsKey($waitId)) {
        $r = $pending[$waitId]; $pending.Remove($waitId); return $r
      }
      if ([Environment]::TickCount64 -gt $deadline) { throw "CDP timeout waiting for id $waitId" }
      if ($ws.State -ne [System.Net.WebSockets.WebSocketState]::Open) { throw 'ws closed' }
      $sb = [Text.StringBuilder]::new()
      do {
        $result = $ws.ReceiveAsync([ArraySegment[byte]]::new($readBuf), [Threading.CancellationToken]::None).GetAwaiter().GetResult()
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Text) {
          [void]$sb.Append([Text.Encoding]::UTF8.GetString($readBuf, 0, $result.Count))
        } elseif ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
          throw 'ws closed by peer'
        }
      } while (-not $result.EndOfMessage)
      $msg = $sb.ToString() | ConvertFrom-Json
      if ($null -ne $msg.id -and $pending.ContainsKey([int]$msg.id)) {
        $pending[[int]$msg.id] = $msg
      }
    }
  }

  function Send-Cdp([string]$method, $params = $null) {
    $script:nextId += 1
    $id = $script:nextId
    $payload = @{ id = $id; method = $method } | ConvertTo-Json -Compress -Depth 10
    if ($null -ne $params) {
      $paramsJson = $params | ConvertTo-Json -Compress -Depth 20
      $payload = '{"id":' + $id + ',"method":"' + $method + '","params":' + $paramsJson + '}'
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $script:pending[$id] = $null
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    return Receive-Loop $id
  }

  function Eval-JS([string]$expr) {
    $r = Send-Cdp 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
    return $r.result.result.value
  }

  # 4) navigate + enable domains
  [void](Send-Cdp 'Page.enable')
  [void](Send-Cdp 'Runtime.enable')
  [void](Send-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = 1560; height = 2200; deviceScaleFactor = 1; mobile = $false })
  [void](Send-Cdp 'Page.navigate' @{ url = $Url })

  # 5) wait for the app to boot and a session to be open (tabs appear)
  $tabs = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 1000
    try {
      $state = Eval-JS "({ href: location.href, ready: document.readyState, scripts: document.scripts.length, bodyLen: (document.body ? document.body.innerText.length : -1), tabs: [...document.querySelectorAll('[role=tab]')].map(x => x.textContent.trim()) })"
      if ($state.tabs -and $state.tabs.length) { $tabs = $state.tabs; break }
      if ($i % 10 -eq 9) { Write-Host "  wait... href=$($state.href) ready=$($state.ready) scripts=$($state.scripts) bodyLen=$($state.bodyLen)" }
    } catch { }
  }
  Write-Host "tabs: $($tabs -join ' / ')"
  if (-not $tabs) {
    $diag = Eval-JS "(() => { const t = document.querySelector('#root') || document.body; return { href: location.href, ready: document.readyState, html: t ? t.innerHTML.slice(0, 800) : '(no root/body)' }; })()"
    Write-Host "diag: $($diag | ConvertTo-Json -Compress)"
    throw 'no conversation tabs appeared'
  }

  # 6) click the 用量 tab
  $clicked = Eval-JS "(() => { const t = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === '\u7528\u91cf'); if (!t) return false; t.click(); return true; })()"
  Write-Host "usage tab clicked: $clicked"

  # 7) wait for the usage view to render
  $view = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $view = Eval-JS "(() => { const v = document.querySelector('.dsh-tl-view'); if (!v) return null; return { cards: document.querySelectorAll('.dsh-tl-card').length, bars: document.querySelectorAll('.dsh-tl-col').length, text: v.innerText.slice(0, 400) }; })()"
      if ($view -and $view.cards -gt 0) { break }
    } catch { }
  }
  Write-Host "usage view: $($view | ConvertTo-Json -Compress)"

  # 8) screenshot
  Start-Sleep -Milliseconds 800
  $shot = Send-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $true }
  $b64 = $shot.result.data
  [IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($b64))
  Write-Host "screenshot saved: $Out ($([Math]::Round((Get-Item $Out).Length / 1kb)) KB)"
}
finally {
  try { if ($ws) { $ws.Dispose() } } catch { }
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
