param(
  [string]$ChromeExecutable = $env:STAGE2_CHROME_EXECUTABLE,
  [string]$ChromeProfile = $env:STAGE2_CHROME_PROFILE
)

if ([string]::IsNullOrWhiteSpace($ChromeExecutable)) {
  $ChromeExecutable = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}
if ([string]::IsNullOrWhiteSpace($ChromeProfile)) {
  $ChromeProfile = Join-Path $env:USERPROFILE 'ChromeStage2Applications'
}
if (-not (Test-Path -LiteralPath $ChromeExecutable -PathType Leaf)) {
  throw "Chrome executable not found: $ChromeExecutable"
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ChromeExecutable).Path
$profileParent = Split-Path -Parent $ChromeProfile
if (-not (Test-Path -LiteralPath $profileParent -PathType Container)) {
  throw "Chrome profile parent does not exist: $profileParent"
}

Start-Process -FilePath $resolvedExecutable -ArgumentList @(
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9224',
  "--user-data-dir=$ChromeProfile",
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
)
