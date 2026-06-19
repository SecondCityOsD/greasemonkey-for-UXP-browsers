# build-xpi.ps1 — package Greasemonkey for UXP into an installable XPI.
#
# Usage:
#   PS> .\build-xpi.ps1
#
# Reads the version from install.rdf and writes
# greasemonkey-<version>.xpi alongside this script.
#
# Windows counterpart to build.sh; it packages the SAME members.  Both
# scripts use an explicit ALLOW-LIST ($includeTop below / the `cp -r` list in
# build.sh) rather than a blacklist of exclusions.  That choice is
# deliberate: a blacklist fails open — a new top-level repo file (release
# notes, a CI manifest, another helper script) silently ships inside every
# install until someone notices.  An allow-list fails closed: anything not
# named is left out, and a genuinely new runtime member is caught the moment
# the extension fails to load.  Keep $includeTop in sync with build.sh.
#
# Intentionally NOT shipped: .git/.github, _attic/, docs/, tests/, tools/,
# README.md, CHANGELOG.md, Contributing.md, CLAUDE.md, .editorconfig,
# .gitignore, the build scripts themselves, previous *.xpi builds, and
# update.rdf (a server-side auto-update manifest the browser reaches via the
# <em:updateURL> in install.rdf — not a package member).

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

# Canonical XPI member set — MUST match the `cp -r` whitelist in build.sh.
# A top-level entry (file or directory) ships only if its name is here.
$includeTop = @(
    'chrome.manifest',
    'components',
    'content',
    'defaults',
    'install.rdf',
    'LICENSE',
    'locale',
    'modules',
    'skin'
)

# Editor / Photoshop leftovers that build.sh strips from the build tree
# (find ... -name '*~' / '#*' / '*.psd').  Skip them here too so both
# builds produce the same file set even if such a file slips into a
# whitelisted directory.
$excludeLeaf = '(~$)|(^#)|(\.psd$)'

$zip = [System.IO.Compression.ZipFile]::Open($out, 'Create')
$count = 0
try {
    $files = Get-ChildItem -Path $src -Recurse -File
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($src.Length + 1).Replace('\', '/')
        $top = $rel.Split('/')[0]
        if ($includeTop -notcontains $top) { continue }
        if ($f.Name -match $excludeLeaf) { continue }
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
