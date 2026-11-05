[CmdletBinding()]
param([switch]$AllowCiWorkspace)

# Dependency preparation only: this script does not launch PPT-ai, perform OCR,
# import inference libraries, run tests, or compile the application.
# Execute only after the required Storage Preflight for installation/downloads.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$destination = Join-Path $projectRoot 'app\ocr-runtime'
$pythonDir = Join-Path $destination 'python'
$sitePackages = Join-Path $destination 'site-packages'
$modelsDir = Join-Path $destination 'models'
$downloadDir = Join-Path $projectRoot '.cache\ocr-downloads'
$tempDir = Join-Path $projectRoot 'work\ocr-prepare-temp'
$pipCache = Join-Path $projectRoot '.cache\pip-ocr'
$requirements = Join-Path $projectRoot 'app\m1\ocr-requirements.txt'
$utf8 = New-Object Text.UTF8Encoding($false)
$downloadSources = @{}
$ciWorkspace = $null
if ($AllowCiWorkspace) {
    if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:GITHUB_WORKSPACE -or -not [IO.Path]::IsPathRooted($env:GITHUB_WORKSPACE)) {
        throw '-AllowCiWorkspace is restricted to a GitHub Actions workspace'
    }
    $ciWorkspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\')
    if ($projectRoot -ne $ciWorkspace -and -not $projectRoot.StartsWith($ciWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'OCR project root is outside GITHUB_WORKSPACE'
    }
}

function Assert-WriteLocation([string]$Value) {
    $full = [IO.Path]::GetFullPath($Value)
    if ($AllowCiWorkspace) {
        if ($full -ne $ciWorkspace -and -not $full.StartsWith($ciWorkspace + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw "OCR CI write path must stay inside GITHUB_WORKSPACE: $full"
        }
    } elseif (-not $full.StartsWith('F:\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "OCR preparation must write to the approved F drive: $full"
    }
    $ancestor = $full
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Cannot establish the physical OCR write location through reparse point: $ancestor"
            }
        }
        $next = Split-Path -Parent $ancestor
        if ($next -eq $ancestor) { break }
        $ancestor = $next
    }
}

function Assert-Hash([string]$File, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Expected) {
        throw "SHA256 mismatch: $File. No OCR models were accepted."
    }
}

function Get-VerifiedFile([string]$Name, [string]$Uri, [string]$Expected, [string]$AlternateUri = '') {
    $file = Join-Path $downloadDir $Name
    if (Test-Path -LiteralPath $file) { Assert-Hash $file $Expected; $downloadSources[$Name] = 'verified-local-cache'; return $file }
    $partial = $file + '.partial'
    # The maintainer's immutable Hugging Face copy (or Paddle's tagged dictionary)
    # is preferred when available; the catalog's ModelScope URL is the fallback.
    # Both candidates must have exactly the same pinned upstream SHA256.
    $candidates = @($Uri)
    if ($AlternateUri) { $candidates = @($AlternateUri, $Uri) }
    foreach ($candidate in $candidates) {
        $provider = ([Uri]$candidate).Host
        Write-Host "Downloading $Name from $provider"
        try {
            Invoke-WebRequest -Uri $candidate -OutFile $partial -UseBasicParsing -TimeoutSec 90
            Assert-Hash $partial $Expected
            Move-Item -LiteralPath $partial -Destination $file -Force
            $downloadSources[$Name] = $candidate
            return $file
        } catch {
            Write-Host "Download unavailable: $Name from $provider"
        }
    }
    throw "Unable to obtain verified resource after bounded download attempts: $Name"
}

function Expand-VerifiedZip([string]$Archive, [string]$Target) {
    Assert-WriteLocation $Target
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    $prefix = [IO.Path]::GetFullPath($Target).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('/', '\')
            $output = [IO.Path]::GetFullPath((Join-Path $Target $name))
            if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes OCR runtime: $name"
            }
            if ($name.EndsWith('\')) {
                New-Item -ItemType Directory -Path $output -Force | Out-Null
            } else {
                New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $output, $true)
            }
        }
    } finally { $zip.Dispose() }
}

function Test-PinnedDependenciesPresent {
    # File metadata inventory only. This does not import or execute OCR packages.
    $installed = @{}
    foreach ($directory in @(Get-ChildItem -LiteralPath $sitePackages -Directory -Filter '*.dist-info')) {
        $metadataFile = Join-Path $directory.FullName 'METADATA'
        if (-not (Test-Path -LiteralPath $metadataFile)) { continue }
        $packageName = $null
        $packageVersion = $null
        foreach ($line in @(Get-Content -LiteralPath $metadataFile)) {
            if ($line -match '^Name: (.+)$') { $packageName = $Matches[1].Trim() }
            if ($line -match '^Version: (.+)$') { $packageVersion = $Matches[1].Trim() }
            if ($packageName -and $packageVersion) { break }
        }
        if ($packageName -and $packageVersion) {
            $key = ($packageName -replace '[-_.]+', '-').ToLowerInvariant()
            if ($installed.ContainsKey($key) -and $installed[$key] -ne $packageVersion) { return $false }
            $installed[$key] = $packageVersion
        }
    }
    foreach ($line in @(Get-Content -LiteralPath $requirements)) {
        $requirement = $line.Trim()
        if (-not $requirement -or $requirement.StartsWith('#')) { continue }
        if ($requirement -notmatch '^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+-]+)(?:\s*;.*)?$') { return $false }
        $key = ($Matches[1] -replace '[-_.]+', '-').ToLowerInvariant()
        $expected = $Matches[2]
        if (-not $installed.ContainsKey($key) -or $installed[$key] -ne $expected) { return $false }
    }
    return $true
}

foreach ($dir in @($projectRoot, $destination, $downloadDir, $tempDir, $pipCache, $sitePackages, $modelsDir)) {
    Assert-WriteLocation $dir
}
if (-not (Test-Path -LiteralPath $requirements)) { throw 'Missing OCR dependency lock file' }
foreach ($dir in @($destination, $downloadDir, $tempDir, $pipCache, $sitePackages, $modelsDir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
Add-Type -AssemblyName System.IO.Compression.FileSystem

$oldEnv = @{}
foreach ($name in @('TEMP', 'TMP', 'PIP_CACHE_DIR', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUSERBASE')) {
    $oldEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:TEMP = $tempDir
    $env:TMP = $tempDir
    $env:PIP_CACHE_DIR = $pipCache
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:PYTHONUSERBASE = Join-Path $destination 'unused-user-base'

    # SHA256 is the digest in python.org's corresponding .zip.sigstore bundle.
    $pythonArchive = Get-VerifiedFile 'python-3.12.10-embed-amd64.zip' `
        'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' `
        '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
    Expand-VerifiedZip $pythonArchive $pythonDir
    # The embedded interpreter ignores global Python and user package paths.
    # Only our sibling site-packages directory is added, without user site hooks.
    [IO.File]::WriteAllText((Join-Path $pythonDir 'python312._pth'), "python312.zip`n.`n..\site-packages`n", $utf8)

    $bootstrap = @(
        @('pip-25.0.1-py3-none-any.whl', 'https://files.pythonhosted.org/packages/c9/bc/b7db44f5f39f9d0494071bddae6880eb645970366d0a200022a1a93d57f5/pip-25.0.1-py3-none-any.whl', 'c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f'),
        @('setuptools-75.8.2-py3-none-any.whl', 'https://files.pythonhosted.org/packages/a9/38/7d7362e031bd6dc121e5081d8cb6aa6f6fedf2b67bf889962134c6da4705/setuptools-75.8.2-py3-none-any.whl', '558e47c15f1811c1fa7adbd0096669bf76c1d3f433f58324df69f3f5ecac4e8f'),
        @('wheel-0.45.1-py3-none-any.whl', 'https://files.pythonhosted.org/packages/0b/2c/87f3254fd8ffd29e4c02732eee68a83a1d3c346ae39bc6822dcbcb697f2b/wheel-0.45.1-py3-none-any.whl', '708e7481cc80179af0e556bbf0cc00b8444c7321e2700b8d8580231d13017248')
    )
    foreach ($item in $bootstrap) {
        $archive = Get-VerifiedFile $item[0] $item[1] $item[2]
        Expand-VerifiedZip $archive $sitePackages
    }
    $python = Join-Path $pythonDir 'python.exe'
    # The sole source-only dependency (ANTLR's Python runtime) builds a pure
    # Python wheel with the pinned bundled setuptools/wheel, without a compiler.
    if (Test-PinnedDependenciesPresent) {
        Write-Output 'Reusing installed dependency versions from METADATA inventory; no import or test was run.'
    } else {
        & $python -I -B -m pip --isolated --disable-pip-version-check install `
            --no-cache-dir --no-build-isolation --no-compile --no-warn-script-location `
            --index-url 'https://pypi.org/simple' --target $sitePackages --upgrade -r $requirements
        if ($LASTEXITCODE -ne 0) { throw 'OCR dependency installation failed; no successful preparation was recorded' }
    }

    $modelInputs = @(
        @('ch_PP-OCRv4_det_mobile.onnx', 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx', 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9', 'https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'),
        @('ch_PP-OCRv4_rec_mobile.onnx', 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx', '48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b', 'https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx'),
        @('ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c', 'https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv1/ch_ppocr_mobile_v2.0_cls_infer.onnx'),
        @('ppocr_keys_v1.txt', 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v2.0.7/paddle/PP-OCRv4/rec/ch_PP-OCRv4_rec_infer/ppocr_keys_v1.txt', '28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7', 'https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/v2.7.0/ppocr/utils/ppocr_keys_v1.txt')
    )
    $modelManifest = foreach ($item in $modelInputs) {
        $file = Get-VerifiedFile $item[0] $item[1] $item[2] $item[3]
        $output = Join-Path $modelsDir $item[0]
        Copy-Item -LiteralPath $file -Destination $output -Force
        Assert-Hash $output $item[2]
        [pscustomobject]@{ file = $item[0]; sha256 = $item[2]; bytes = (Get-Item -LiteralPath $output).Length; source = $downloadSources[$item[0]]; catalogSource = $item[1]; alternateSource = $item[3] }
    }

    # Keep installed upstream license/notice texts with this separate runtime.
    $licenseDir = Join-Path $destination 'licenses'
    New-Item -ItemType Directory -Path $licenseDir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'third_party\OCR-NOTICE.md') -Destination (Join-Path $licenseDir 'OCR-NOTICE.md') -Force
    $licenseFiles = Get-ChildItem -LiteralPath $sitePackages -Recurse -File | Where-Object {
        $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)(\b|[-_.])' -or $_.Name -match 'LICENSES?\.txt$'
    }
    foreach ($item in $licenseFiles) {
        $relative = $item.FullName.Substring($sitePackages.Length).TrimStart('\')
        $output = Join-Path $licenseDir ('packages\' + $relative)
        New-Item -ItemType Directory -Path (Split-Path -Parent $output) -Force | Out-Null
        Copy-Item -LiteralPath $item.FullName -Destination $output -Force
    }
    if (Test-Path -LiteralPath (Join-Path $pythonDir 'LICENSE.txt')) {
        Copy-Item -LiteralPath (Join-Path $pythonDir 'LICENSE.txt') -Destination (Join-Path $licenseDir 'Python-LICENSE.txt') -Force
    }
    $metadata = @(Get-ChildItem -LiteralPath $sitePackages -Directory -Filter '*.dist-info' | ForEach-Object {
        $name = $_.Name
        $metadataFile = Join-Path $_.FullName 'METADATA'
        # Plain .NET strings avoid serializing Get-Content's attached filesystem
        # provider objects into the runtime manifest under Windows PowerShell.
        $fields = @([IO.File]::ReadLines($metadataFile) | Where-Object { $_ -match '^(Name|Version|License|License-Expression):' } | ForEach-Object { [string]$_ })
        [pscustomobject]@{ distribution = $name; fields = $fields }
    })
    $manifest = [ordered]@{
        format = 1
        preparedAtUtc = [DateTime]::UtcNow.ToString('o')
        preparationOnly = $true
        softwareTestsRun = $false
        runtime = 'CPython 3.12.10 embedded Windows x64'
        pythonArchiveSha256 = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
        ocr = 'rapidocr==3.9.2'
        inference = 'onnxruntime==1.23.2 CPU'
        requirementsSha256 = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash.ToLowerInvariant()
        models = @($modelManifest)
        installedDistributions = $metadata
    }
    [IO.File]::WriteAllText((Join-Path $destination 'runtime-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
    Write-Output "OCR resources prepared: $destination. No application or OCR test was run."
} finally {
    foreach ($name in $oldEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnv[$name], 'Process') }
}
