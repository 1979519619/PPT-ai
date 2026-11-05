[CmdletBinding()]
param([string]$Directory, [string]$Version)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = ([IO.File]::ReadAllText((Join-Path $root 'app\package.json')) | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid installer version' }
if (-not $Directory) { $Directory = Join-Path $root ('app\dist\' + $Version) }
$file = Join-Path ([IO.Path]::GetFullPath($Directory)) ('PPT-AI-Setup-' + $Version + '.exe')
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Expected current installer not found: $file" }
$line = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($file)
[IO.File]::WriteAllText((Join-Path $Directory 'SHA256SUMS'), $line + "`r`n", [Text.ASCIIEncoding]::new())
Write-Output ('Checksum written for ' + [IO.Path]::GetFileName($file))
