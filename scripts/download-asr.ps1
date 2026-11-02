[CmdletBinding()]
param(
    [string]$ArchivePath,
    [string]$ModelPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $projectRoot '.cache\asr'
$destination = Join-Path $projectRoot 'app\asr'
$archiveSha = '6BA69E3482D7826214F90A6A9C84CA07782AEC1E1D0C6A7C30C994FD5D816CCB'
$modelSha = '1BE3A9B2063867B937E64E2EC7483364A79917E157FA98C5D94B5C1FFFEA987B'
New-Item -ItemType Directory -Path $cache -Force | Out-Null

function Assert-Hash([string]$File, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Expected) {
        throw "SHA256 mismatch: $File. The resource was not installed."
    }
}
function Get-VerifiedFile([string]$File, [string]$Uri, [string]$Expected) {
    if (Test-Path -LiteralPath $File) { Assert-Hash $File $Expected; return }
    $partial = $File + '.partial'
    Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing
    Assert-Hash $partial $Expected
    Move-Item -LiteralPath $partial -Destination $File -Force
}

if (-not $ArchivePath) {
    $ArchivePath = Join-Path $cache 'whisper-bin-x64-b5454.zip'
    Get-VerifiedFile $ArchivePath 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' $archiveSha
}
if (-not $ModelPath) {
    $ModelPath = Join-Path $cache 'ggml-small.bin'
    Get-VerifiedFile $ModelPath 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small.bin' $modelSha
}
Assert-Hash $ArchivePath $archiveSha
Assert-Hash $ModelPath $modelSha

# Fixed, verified upstream archive; extract only required runtime files.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
try {
    $runtime = Join-Path $destination 'Release'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $server = $zip.GetEntry('Release/whisper-server.exe')
    if (-not $server) { throw 'Archive has no expected server executable' }
    $entries = @($zip.Entries | Where-Object {
        $_.FullName -match '^Release/(whisper-server\.exe|whisper\.dll|ggml[^/]*\.dll)$'
    })
    foreach ($entry in $entries) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $entry.Name), $true)
    }
    Copy-Item -LiteralPath $ModelPath -Destination (Join-Path $destination 'ggml-small.bin') -Force
} finally { $zip.Dispose() }
Write-Output "ASR ready: $destination (b5454 + full small, SHA256 verified)"
