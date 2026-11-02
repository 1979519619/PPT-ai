param([string]$Directory = (Join-Path $PSScriptRoot '..\app\dist'))
$ErrorActionPreference = 'Stop'
$files = @(Get-ChildItem -LiteralPath $Directory -File -Filter 'PPT-AI-Setup-*.exe')
if ($files.Count -eq 0) { throw 'No installer found' }
$lines = foreach ($file in $files) {
    (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $file.Name
}
$lines | Set-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS') -Encoding ascii
