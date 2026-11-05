[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$RegisteredMachineRoot,
    [string]$RegisteredUserRoot
)

# Invoked by the installer/uninstaller only. Scope is exact executable/script
# locations belonging to this product, never all Python/Whisper processes.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-ProductRoot([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $full = [IO.Path]::GetFullPath($Value).TrimEnd('\')
    if (-not [IO.Path]::IsPathRooted($full) -or $full.Length -lt 5 -or
        $full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw 'Unsafe installation directory' }
    if (-not (Test-Path -LiteralPath (Join-Path $full 'PPT-AI Classroom.exe') -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installation directory is a reparse point; close the application manually' }
    return $full
}

function Save-LegacyAssets([string]$Root) {
    $assets = Join-Path $Root 'assets'
    if (-not (Test-Path -LiteralPath $assets -PathType Container)) { return }
    $entries = @(Get-ChildItem -LiteralPath $assets -Recurse -Force)
    if (((Get-Item -LiteralPath $assets -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        @($entries | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) {
        throw 'Move user assets outside the installation directory before updating (reparse point found)'
    }
    $backupBase = Join-Path (Split-Path -Parent $Root) ((Split-Path -Leaf $Root) + '-user-files')
    $backup = Join-Path $backupBase (([DateTime]::Now.ToString('yyyyMMdd-HHmmss')) + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '\assets')
    $expectedPrefix = [IO.Path]::GetFullPath($backupBase).TrimEnd('\') + '\'
    $backup = [IO.Path]::GetFullPath($backup)
    if (-not $backup.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $backup.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe assets backup path' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
    Copy-Item -LiteralPath $assets -Destination $backup -Recurse -Force
    $sourcePrefix = $assets.TrimEnd('\') + '\'
    foreach ($file in @($entries | Where-Object { -not $_.PSIsContainer })) {
        $relative = $file.FullName.Substring($sourcePrefix.Length)
        $copied = Join-Path $backup $relative
        if (-not (Test-Path -LiteralPath $copied -PathType Leaf) -or
            (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $copied -Algorithm SHA256).Hash) { throw 'User assets backup was not completed; update cancelled' }
    }
    Write-Output "User assets preserved outside the installation folder: $backup"
}

function Test-ProductProcess($Process, [string[]]$Roots) {
    if (-not $Process.ExecutablePath -or [int]$Process.ProcessId -eq $PID) { return $false }
    $exe = [string]$Process.ExecutablePath
    foreach ($root in $Roots) {
        foreach ($relative in @('PPT-AI Classroom.exe', 'resources\asr\Release\whisper-server.exe',
            'resources\ocr-runtime\python\python.exe', 'resources\ocr-runtime\python\pythonw.exe')) {
            if ($exe.Equals((Join-Path $root $relative), [StringComparison]::OrdinalIgnoreCase)) { return $true }
        }
        if ([IO.Path]::GetFileName($exe) -ieq 'powershell.exe') {
            foreach ($relative in @('resources\detector.ps1', 'resources\slide-text.ps1')) {
                $script = [regex]::Escape((Join-Path $root $relative))
                if ([string]$Process.CommandLine -match ('(?i)(?:^|[\s"])' + $script + '(?:[\s"]|$)')) { return $true }
            }
        }
    }
    return $false
}

try {
    $roots = @(@($InstallRoot, $RegisteredMachineRoot, $RegisteredUserRoot) | ForEach-Object { Get-ProductRoot $_ } | Where-Object { $_ } | Select-Object -Unique)
    foreach ($root in $roots) { Save-LegacyAssets $root }
    # Re-enumerate after each stop to avoid relying on a stale PID snapshot.
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $owned = @(Get-CimInstance Win32_Process | Where-Object { Test-ProductProcess $_ $roots })
        if ($owned.Count -eq 0) { exit 0 }
        foreach ($process in $owned) {
            $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$process.ProcessId)
            if ($current -and (Test-ProductProcess $current $roots)) { Stop-Process -Id ([int]$current.ProcessId) -Force -ErrorAction SilentlyContinue }
        }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-CimInstance Win32_Process | Where-Object { Test-ProductProcess $_ $roots })
    if ($remaining.Count -gt 0) { throw 'PPT-AI processes are still using installation files; close PPT-AI and retry' }
    exit 0
} catch {
    Write-Output ('PPT-AI update preparation failed: ' + $_.Exception.Message)
    exit 1
}
