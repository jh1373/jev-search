param([string]$Root = (Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference = 'Stop'
$files = @((Join-Path $Root 'README.md')) + @((Join-Path $Root 'docs\acceptance-status.md')) + @(Get-ChildItem (Join-Path $Root 'docs\design') -Filter '*.md' | ForEach-Object FullName) + @((Join-Path $Root 'docs\privacy.md')) + @((Join-Path $Root 'docs\benchmark\protocol.md'))
$reviewDirectory = Join-Path $Root 'docs\reviews'
if (Test-Path -LiteralPath $reviewDirectory) {
  $files += @(Get-ChildItem -LiteralPath $reviewDirectory -Filter '*.md' -File | ForEach-Object FullName)
}
$errors = [System.Collections.Generic.List[string]]::new()
if (@(Get-ChildItem (Join-Path $Root 'docs\design') -Filter '*.md').Count -ne 9) { $errors.Add('Expected nine active design documents') }
foreach ($file in $files) {
  $text = [IO.File]::ReadAllText($file)
  if ($text.Contains([string][char]0xFFFD)) { $errors.Add("Replacement character: $file") }
  if (([regex]::Matches($text, '(?m)^```').Count % 2) -ne 0) { $errors.Add("Unbalanced fence: $file") }
  foreach ($match in [regex]::Matches($text, '\]\(([^)]+)\)')) {
    $target = $match.Groups[1].Value
    if ($target -match '^(https?://|#)') { continue }
    $local = Join-Path (Split-Path $file -Parent) ($target.Split('#')[0])
    if (-not (Test-Path -LiteralPath $local)) { $errors.Add("Broken link: $file -> $target") }
  }
}
$requirements = [IO.File]::ReadAllText((Join-Path $Root 'docs\design\01-architecture.md'))
$acceptance = [IO.File]::ReadAllText((Join-Path $Root 'docs\design\07-acceptance.md'))
$ids = @([regex]::Matches($requirements, '\b(?:F|S|N)-\d{2}\b') | ForEach-Object Value | Sort-Object -Unique)
foreach ($id in $ids) { if (-not $acceptance.Contains($id)) { $errors.Add("Unmapped requirement: $id") } }
if ($errors.Count) { $errors | ForEach-Object { Write-Error $_ -ErrorAction Continue }; exit 1 }
Write-Output ("PASS: {0} documents, {1} mapped requirements, local links and fences valid." -f $files.Count,$ids.Count)
