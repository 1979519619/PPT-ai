[CmdletBinding()]
param([switch]$AllowCiWorkspace)

# Build input preparation only. Never launches the application, inference,
# installer, a test runner, or an already built package.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$cache = Join-Path $projectRoot '.cache\build-prerequisites'
$vendor = Join-Path $projectRoot 'app\build\vendor'
$generated = Join-Path $projectRoot 'app\build\generated'
$tempDir = Join-Path $projectRoot 'work\build-prepare-temp'
$ciRoot = $null
if ($AllowCiWorkspace) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:GITHUB_WORKSPACE) { throw 'CI override requires GitHub Actions' }
    $ciRoot = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
}
function Assert-OutputLocation([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if ($ciRoot) {
        if ($full -ne $ciRoot -and -not $full.StartsWith($ciRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Build preparation is outside GITHUB_WORKSPACE' }
    } elseif (-not $full.StartsWith('F:\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Local build preparation must remain on F:' }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Unconfirmed physical output: $ancestor" }
        }
        $next = Split-Path -Parent $ancestor
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
}
foreach ($location in @($cache, $vendor, $generated, $tempDir)) {
    Assert-OutputLocation $location
    New-Item -ItemType Directory -Path $location -Force | Out-Null
}
$savedTemp = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
$savedTmp = [Environment]::GetEnvironmentVariable('TMP', 'Process')
try {
    $env:TEMP = $tempDir
    $env:TMP = $tempDir
    $version = '14.51.36247.0'
    $expected = '843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C'
    $url = 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe'
    $archive = Join-Path $cache ('VC_redist.x64-' + $version + '.exe')
    if (-not (Test-Path -LiteralPath $archive)) {
        $partial = $archive + '.partial'
        Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash -ne $expected) { throw 'Microsoft redistributable download SHA256 mismatch' }
        Move-Item -LiteralPath $partial -Destination $archive -Force
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'Cached Microsoft redistributable SHA256 mismatch' }
    $signature = Get-AuthenticodeSignature -LiteralPath $archive
    if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)') { throw 'Redistributable is not signed by Microsoft Corporation' }
    Copy-Item -LiteralPath $archive -Destination (Join-Path $vendor 'VC_redist.x64.exe') -Force

    # NSIS custom license pages do not get electron-builder's automatic license
    # transcoding. Generate readable plain UTF-8 BOM / CRLF text explicitly.
    $text = [IO.File]::ReadAllText((Join-Path $projectRoot 'PRIVACY.md'))
    $text = [regex]::Replace($text, '(?m)^#{1,6}\s+', '')
    $text = [regex]::Replace($text, '\[([^\]]+)\]\(([^)]+)\)', '$1 ($2)')
    $text = $text.Replace('**', '').Replace('`', '')
    $text = [regex]::Replace($text, '\r\n?|\n', "`r`n")
    [IO.File]::WriteAllText((Join-Path $generated 'PRIVACY.txt'), $text, [Text.UTF8Encoding]::new($true))
    $manifest = [ordered]@{
        preparedAtUtc = [DateTime]::UtcNow.ToString('o')
        purpose = 'Build input preparation only; no application, tests or installer executed'
        vcRedistVersion = $version
        vcRedistSha256 = $expected.ToLowerInvariant()
        vcRedistBytes = (Get-Item -LiteralPath $archive).Length
        source = $url
        hashSource = 'https://github.com/microsoft/winget-pkgs/blob/master/manifests/m/Microsoft/VCRedist/2015%2B/x64/14.51.36247.0/Microsoft.VCRedist.2015%2B.x64.installer.yaml'
        signer = [string]$signature.SignerCertificate.Subject
        signatureStatus = [string]$signature.Status
        privacyText = 'UTF-8 BOM / CRLF / plain text'
    }
    [IO.File]::WriteAllText((Join-Path $generated 'build-inputs.json'), ($manifest | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Write-Output "Build inputs prepared: $vendor ; $generated. No installer or software test executed."
} finally {
    [Environment]::SetEnvironmentVariable('TEMP', $savedTemp, 'Process')
    [Environment]::SetEnvironmentVariable('TMP', $savedTmp, 'Process')
}
