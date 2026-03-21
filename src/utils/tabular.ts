import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { CsvRow, readCsv, writeCsv } from "./csv";

function isXlsx(filePath: string) {
  return /\.xlsx$/i.test(filePath);
}

function runPowerShell(script: string) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function escapePowerShellSingleQuoted(value: string) {
  return value.replace(/'/g, "''");
}

function decodeBase64Utf8(value: string) {
  return Buffer.from(value.trim(), "base64").toString("utf8");
}

function readXlsx(filePath: string): CsvRow[] {
  const escapedPath = escapePowerShellSingleQuoted(filePath);
  const script = `
$ErrorActionPreference = 'Stop'
$path = '${escapedPath}'
$excel = $null
$workbook = $null
 $usedRange = $null
 $worksheet = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($path)
  $worksheet = $workbook.Worksheets.Item(1)
  $usedRange = $worksheet.UsedRange
  $rowCount = [int]$usedRange.Rows.Count
  $columnCount = [int]$usedRange.Columns.Count
  if ($rowCount -lt 1 -or $columnCount -lt 1) {
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('[]'))
    return
  }

  $headers = @()
  for ($c = 1; $c -le $columnCount; $c++) {
    $headers += [string]$usedRange.Cells.Item(1, $c).Text
  }

  $rows = New-Object System.Collections.Generic.List[object]
  for ($r = 2; $r -le $rowCount; $r++) {
    $obj = [ordered]@{}
    for ($c = 1; $c -le $columnCount; $c++) {
      $header = $headers[$c - 1]
      if (-not $header) { continue }
      $obj[$header] = [string]$usedRange.Cells.Item($r, $c).Text
    }
    $rows.Add([pscustomobject]$obj)
  }

  $json = $rows | ConvertTo-Json -Depth 5 -Compress
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}
finally {
  if ($workbook) { $workbook.Close($false) | Out-Null }
  if ($excel) {
    $excel.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($usedRange)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`.trim();

  const raw = runPowerShell(script).trim();
  if (!raw || raw === "null") return [];
  const parsed = JSON.parse(decodeBase64Utf8(raw));
  if (Array.isArray(parsed)) return parsed as CsvRow[];
  return [parsed as CsvRow];
}

function writeXlsx(filePath: string, rows: CsvRow[], headers: string[]) {
  const tempJsonPath = path.join(os.tmpdir(), `job-autopilot-xlsx-${Date.now()}.json`);
  fs.writeFileSync(tempJsonPath, JSON.stringify({ rows, headers }), "utf8");
  const escapedPath = escapePowerShellSingleQuoted(filePath);
  const escapedJsonPath = escapePowerShellSingleQuoted(tempJsonPath);
  const script = `
$ErrorActionPreference = 'Stop'
$path = '${escapedPath}'
$jsonPath = '${escapedJsonPath}'
$payload = Get-Content $jsonPath -Raw | ConvertFrom-Json
$headers = @($payload.headers)
$rows = @($payload.rows)
$excel = $null
$workbook = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($path)
  $worksheet = $workbook.Worksheets.Item(1)
  $worksheet.Cells.Clear() | Out-Null

  for ($c = 0; $c -lt $headers.Count; $c++) {
    $worksheet.Cells.Item(1, $c + 1).Value2 = [string]$headers[$c]
  }

  for ($r = 0; $r -lt $rows.Count; $r++) {
    $row = $rows[$r]
    for ($c = 0; $c -lt $headers.Count; $c++) {
      $header = [string]$headers[$c]
      $value = ''
      if ($null -ne $row.$header) { $value = [string]$row.$header }
      $worksheet.Cells.Item($r + 2, $c + 1).Value2 = $value
    }
  }

  $workbook.Save() | Out-Null
}
finally {
  if ($workbook) { $workbook.Close($true) | Out-Null }
  if ($excel) {
    $excel.Quit()
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($workbook)
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
  }
  Remove-Item $jsonPath -Force -ErrorAction SilentlyContinue
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`.trim();

  runPowerShell(script);
}

export function readTabular(filePath: string): CsvRow[] {
  return isXlsx(filePath) ? readXlsx(filePath) : readCsv(filePath);
}

export function writeTabular(filePath: string, rows: CsvRow[], headers: string[]) {
  if (isXlsx(filePath)) {
    writeXlsx(filePath, rows, headers);
    return;
  }
  writeCsv(filePath, rows, headers);
}
