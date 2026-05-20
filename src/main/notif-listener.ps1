# Listens for new Windows toast notifications and emits one JSON line per
# notification to stdout. The main Electron process spawns this as a child
# process and parses each line. Stays alive until killed.
#
# Permission model: UserNotificationListener requires user consent. On the
# very first call to RequestAccessAsync() Windows shows a system dialog
# ("Allow this app to read your notifications?"). The choice persists after
# that — subsequent runs skip the prompt.
#
# Output line shape (UTF-8 JSON):
#   {"id": 12345, "app": "QQ", "title": "张三", "body": "你在吗？", "ts": "2026-05-19T10:30:00Z"}
# Plus a one-time status line:
#   {"status": "ready" | "denied" | "unsupported"}

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Emit($obj) {
    # ConvertTo-Json defaults to depth 2 which truncates nested objects;
    # bump it so e.g. body text with weird unicode survives.
    $line = ($obj | ConvertTo-Json -Compress -Depth 5)
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

try {
    [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType=WindowsRuntime] | Out-Null
    [Windows.Foundation.IAsyncOperation`1, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
} catch {
    Emit @{ status = 'unsupported'; error = $_.Exception.Message }
    exit 1
}

# Helper: synchronously await a WinRT IAsyncOperation<T>. PowerShell doesn't
# speak async/await natively so we marshal through the Task interop.
function Await($asyncOp, $resultType) {
    $task = [WindowsRuntimeSystemExtensions]::AsTask($asyncOp.GetAwaiter().GetType().GetMethod('GetResult').Invoke($asyncOp.GetAwaiter(), $null))
    return $task
}

# Simpler approach using AsTask extension — load required assembly first.
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitOp($op, $T) {
    $task = $asTaskGeneric.MakeGenericMethod($T).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$AccessStatus = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus]

# Request permission. Throws if the OS is older than Win10 1607.
try {
    $access = AwaitOp $listener.RequestAccessAsync() $AccessStatus
} catch {
    Emit @{ status = 'unsupported'; error = $_.Exception.Message }
    exit 1
}

if ($access -ne $AccessStatus::Allowed) {
    Emit @{ status = 'denied'; access = $access.ToString() }
    exit 0
}

Emit @{ status = 'ready' }

# Track seen ids so the periodic snapshot doesn't re-emit notifications
# that have already been reported. Bounded LRU-ish — trim when it grows
# past 500 entries (Action Center caps around 20 anyway).
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'

# NotificationChanged event would be the right mechanism but WinRT events
# in PowerShell are flaky (the runspace closes before delivery in many
# setups). Simple polling every 2s is reliable and cheap — Action Center
# already deduplicates rapid-fire toasts so we don't miss bursts.
#
# Backfill suppression: on the very first poll, Action Center still holds
# every notification the user hasn't dismissed (sometimes hours old). We
# don't want the maid commenting on those at every app restart — by
# definition the user already saw them. Prime $seen with current ids
# silently on the first iteration; only EMIT notifications that arrive in
# subsequent polls.
$NotificationKinds = [Windows.UI.Notifications.NotificationKinds]
$primed = $false
while ($true) {
    try {
        $list = AwaitOp $listener.GetNotificationsAsync($NotificationKinds::Toast) ([System.Collections.Generic.IReadOnlyList`1[Windows.UI.Notifications.UserNotification]])
        if (-not $primed) {
            # First poll — record everything currently in Action Center as
            # "already seen" without emitting. The maid stays quiet about
            # leftovers from before this session started.
            foreach ($n in $list) { $seen.Add($n.Id) | Out-Null }
            $primed = $true
            # Skip the emit loop this iteration but still hit Start-Sleep
            # at the bottom of the outer while.
            Start-Sleep -Milliseconds 2000
            continue
        }
        foreach ($n in $list) {
            if ($seen.Contains($n.Id)) { continue }
            $seen.Add($n.Id) | Out-Null
            # AppInfo.DisplayInfo.DisplayName is the human-friendly app name
            # (e.g. "腾讯QQ"). Fall back to AppUserModelId if unavailable.
            $appName = ''
            try { $appName = [string]$n.AppInfo.DisplayInfo.DisplayName } catch {}
            if (-not $appName) {
                try { $appName = [string]$n.AppInfo.AppUserModelId } catch {}
            }
            # Toast XML lives in Visual.Bindings[0].GetTextElements(). The
            # first text element is conventionally the title, the rest are
            # body lines we join with newlines.
            # Force everything through [string] — WinRT property accessors in
            # PowerShell sometimes return IInspectable wrappers that ConvertTo-Json
            # turns into `{}` on the receiving side (Node), breaking `.trim()`.
            $title = ''
            $body = ''
            try {
                $binding = $n.Notification.Visual.GetBinding('ToastGeneric')
                if (-not $binding) { $binding = $n.Notification.Visual.Bindings[0] }
                if ($binding) {
                    $texts = $binding.GetTextElements()
                    if ($texts.Count -gt 0) { $title = [string]$texts[0].Text }
                    if ($texts.Count -gt 1) {
                        $bodyParts = @()
                        for ($i = 1; $i -lt $texts.Count; $i++) { $bodyParts += [string]$texts[$i].Text }
                        $body = ($bodyParts -join "`n")
                    }
                }
            } catch {}

            $ts = ''
            try { $ts = $n.CreationTime.UtcDateTime.ToString('o') } catch {}

            Emit @{
                id    = [uint32]$n.Id
                app   = $appName
                title = $title
                body  = $body
                ts    = $ts
            }
        }
        if ($seen.Count -gt 500) {
            # Trim — rebuild from currently visible ids only.
            $seen.Clear()
            foreach ($n in $list) { $seen.Add($n.Id) | Out-Null }
        }
    } catch {
        # Don't kill the loop on transient WinRT hiccups — log and continue.
        Emit @{ status = 'tick_error'; error = $_.Exception.Message }
    }
    Start-Sleep -Milliseconds 2000
}
