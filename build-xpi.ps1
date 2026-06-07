# build-xpi.ps1 — package Greasemonkey for UXP into an installable XPI.
#
# Usage:
#   PS> .\build-xpi.ps1
#
# Reads the version from install.rdf and writes
# greasemonkey-<version>.xpi alongside this script.
#
# Excludes development-only directories and files that shouldn't ship:
#   - .git/, .github/      — version control
#   - _attic/              — parked work (e.g. editor-draft)
#   - docs/                — architecture / inventory / runbooks
#   - tests/               — smoke-test set
#   - node_modules/        — never used here, defensive
#   - *.xpi                — don't include previous builds
#   - .gitignore, README.md, CLAUDE.md, update.rdf, build-xpi.ps1
#                          — repo-only files

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Resolve project dir (this script lives in it).
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

# Pre-build locale guard (see issue #23): every locale DTD must define all
# en-US entities and be well-formed, or the XPI would ship a fatal XML
# "undefined entity" parse error.  Requires Node; skipped with a warning if
# Node is unavailable so the build still works on minimal machines.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    Write-Host "Checking locale DTD completeness ..."
    & node (Join-Path $src 'tools/check-locales.js')
    if ($LASTEXITCODE -ne 0) {
        throw "Locale DTD check failed (see above) - aborting build."
    }
} else {
    Write-Warning "node not found - skipping locale DTD completeness/well-formedness check."
}

# Read version from install.rdf so the filename always matches.
$installRdf = Join-Path $src 'install.rdf'
if (-not (Test-Path $installRdf)) {
    throw "install.rdf not found at $installRdf"
}
$rdfText = Get-Content $installRdf -Raw
if ($rdfText -match '<em:version>([^<]+)</em:version>') {
    $version = $matches[1]
} else {
    throw "Could not parse <em:version> from install.rdf"
}

$out = Join-Path $src "greasemonkey-$version.xpi"
if (Test-Path $out) { Remove-Item $out -Force }

# Top-level dirs that must never appear in the XPI.
$excludeDirs = @(
    '_attic',
    '.git',
    '.github',
    'docs',
    'tests',
    'node_modules',
    'tools'
)

# File-name patterns that must never appear in the XPI.
$excludeFilesPattern = '\.xpi$|^\.gitignore$|^README\.md$|^CLAUDE\.md$|^update\.rdf$|^build-xpi\.ps1$'

$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$count = 0
try {
    $files = Get-ChildItem -Path $src -Recurse -File
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($src.Length + 1).Replace('\', '/')
        $top = $rel.Split('/')[0]
        if ($excludeDirs -contains $top) { continue }
        if ($rel -match $excludeFilesPattern) { continue }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $f.FullName, $rel,
            [System.IO.Compression.CompressionLevel]::Optimal)
        $count++
    }
} finally {
    $zip.Dispose()
}

$info = Get-Item $out
$sizeKB = [math]::Round($info.Length / 1KB, 1)
Write-Host "XPI built: $($info.FullName)"
Write-Host "Version:   $version"
Write-Host "Files:     $count"
Write-Host "Size:      $sizeKB KB"
