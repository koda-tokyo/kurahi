<#
.SYNOPSIS
  Pack the Kurahi Desktop MSIX on Windows with the Windows SDK's makepri + makeappx.

.DESCRIPTION
  Use this when the Linux-built .msix is not wanted, or to build the full-resolution variant:
  it copies .\layout to a staging folder, swaps in the scale-100/200 + targetsize assets from
  .\Assets-scaled, writes the Partner Center identity into AppxManifest.xml, indexes the assets
  into resources.pri (makepri) and packs (makeappx). Both tools are Microsoft-signed SDK binaries,
  so the ASR rule that blocks unsigned executables does not stop them. Nothing in the package is
  executed. The package stays UNSIGNED: the Microsoft Store signs it on submission.

  Run from the folder that holds this script, layout\ and Assets-scaled\:

    powershell -ExecutionPolicy Bypass -File .\pack-msix.ps1 `
      -IdentityName 'XXXXX.Kurahi' `
      -Publisher 'CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' `
      -PublisherDisplayName 'KODA SōKEN'

  The three values come from Partner Center > Kurahi > Product management > Product identity.

  One-line alternative without PRI (the layout as built on Linux, identity already filled):
    makeappx pack /d layout /p Kurahi_x64.msix /o
#>
param(
  [Parameter(Mandatory = $true)][string]$IdentityName,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)][string]$PublisherDisplayName,
  [string]$Output = (Join-Path $PSScriptRoot 'Kurahi_x64_store.msix')
)
$ErrorActionPreference = 'Stop'

function Find-SdkTool([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $hit = Get-ChildItem -Path $root -Filter $name -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $hit) { throw "$name not found. Install the Windows 10/11 SDK (it ships makeappx and makepri)." }
  # Refuse anything that is not Microsoft-signed.
  $sig = Get-AuthenticodeSignature $hit.FullName
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') {
    throw "$($hit.FullName) is not a valid Microsoft-signed binary."
  }
  return $hit.FullName
}

$makeappx = Find-SdkTool 'makeappx.exe'
$makepri = Find-SdkTool 'makepri.exe'

$layout = Join-Path $PSScriptRoot 'layout'
$scaled = Join-Path $PSScriptRoot 'Assets-scaled'
foreach ($p in @($layout, $scaled)) { if (-not (Test-Path $p)) { throw "missing $p" } }

$stage = Join-Path $env:TEMP ('kurahi-msix-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  Copy-Item -Path (Join-Path $layout '*') -Destination $stage -Recurse
  Remove-Item -Recurse -Force (Join-Path $stage 'Assets')
  Copy-Item -Path $scaled -Destination (Join-Path $stage 'Assets') -Recurse

  # Identity from Partner Center.
  $manifestPath = Join-Path $stage 'AppxManifest.xml'
  [xml]$m = Get-Content -Raw -Encoding UTF8 $manifestPath
  $m.Package.Identity.Name = $IdentityName
  $m.Package.Identity.Publisher = $Publisher
  $m.Package.Properties.PublisherDisplayName = $PublisherDisplayName
  $settings = New-Object System.Xml.XmlWriterSettings
  $settings.Encoding = New-Object System.Text.UTF8Encoding($false)
  $settings.Indent = $true
  $w = [System.Xml.XmlWriter]::Create($manifestPath, $settings)
  $m.Save($w); $w.Close()

  # resources.pri, so Windows picks scale-200 / targetsize / unplated icons.
  $priconfig = Join-Path $stage 'priconfig.xml'
  & $makepri createconfig /cf $priconfig /dq 'en-US_ja-JP' /pv 10.0.0 /o
  if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed ($LASTEXITCODE)" }
  & $makepri new /pr $stage /cf $priconfig /mn $manifestPath /of (Join-Path $stage 'resources.pri') /o
  if ($LASTEXITCODE -ne 0) { throw "makepri new failed ($LASTEXITCODE)" }
  Remove-Item $priconfig

  & $makeappx pack /d $stage /p $Output /o
  if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed ($LASTEXITCODE)" }
  Get-Item $Output | Format-List FullName, Length
  Get-FileHash -Algorithm SHA256 $Output | Format-List Hash
  Write-Host 'Unsigned package ready for Partner Center upload (do not sideload it: unsigned packages do not install).'
}
finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
