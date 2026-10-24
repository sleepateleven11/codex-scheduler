import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, distributionPayload, writeDistribution } from './plugin-common.mjs';

if (process.platform !== 'win32') throw new Error('此打包脚本需要 Windows PowerShell 与 .NET。');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--arch' || !['x64', 'arm64'].includes(args[1]))) throw new Error('仅支持 --arch x64 或 --arch arm64；省略时生成轻量源码包。');
const arch = args[1];
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const dir = path.join(ROOT, 'dist');
await fs.mkdir(dir, { recursive: true });
const target = path.join(dir, `codex-scheduler-${manifest.version}${arch ? `-windows-${arch}` : ''}.zip`);
const temporary = `${target}.${process.pid}.tmp`;
const files = await distributionPayload(ROOT, { arch });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-scheduler-distribution-'));
const includes = files.map(file => file.name);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [System.IO.Path]::GetFullPath(${quote(root)})
$rootPrefix = $root.TrimEnd([char[]]'\\/') + [System.IO.Path]::DirectorySeparatorChar
$archivePath = ${quote(temporary)}
$includes = @(${includes.map(quote).join(', ')})
$files = New-Object 'System.Collections.Generic.List[System.IO.FileInfo]'
foreach ($include in $includes) {
  $item = Get-Item -LiteralPath (Join-Path $root $include) -Force
  if ($item.PSIsContainer) {
    foreach ($file in Get-ChildItem -LiteralPath $item.FullName -File -Recurse -Force) { $files.Add($file) }
  } else { $files.Add($item) }
}
$expected = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
$zip = $null
try {
  $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
  foreach ($file in $files | Sort-Object FullName) {
    $absolute = [System.IO.Path]::GetFullPath($file.FullName)
    if (-not $absolute.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '待打包文件超出项目目录。' }
    $entryName = $absolute.Substring($rootPrefix.Length).Replace('\\', '/')
    if (-not $expected.Add($entryName)) { throw '打包清单包含重复路径。' }
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $inputStream = [System.IO.File]::OpenRead($absolute)
    $outputStream = $entry.Open()
    try { $inputStream.CopyTo($outputStream) }
    finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
} finally {
  if ($zip) { $zip.Dispose() }
  $stream.Dispose()
}

# Read with the standard .NET reader, then extract and compare every payload.
$read = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  if ($read.Entries.Count -ne $expected.Count) { throw 'ZIP 条目数与打包清单不一致。' }
  foreach ($entry in $read.Entries) {
    if ($entry.FullName.Contains([string][char]0xFFFD) -or -not $expected.Contains($entry.FullName)) { throw ('ZIP 文件名编码或清单验证失败：' + $entry.FullName) }
  }
  $cmdNames = @($read.Entries | Where-Object { $_.FullName.EndsWith('.cmd', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.FullName })
  if ($cmdNames.Count -ne 2 -or -not ($cmdNames -ccontains '安装插件.cmd') -or -not ($cmdNames -ccontains '卸载插件.cmd')) { throw '中文安装与卸载入口文件名验证失败。' }
} finally { $read.Dispose() }

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([char[]]'\\/')
$extractPath = [System.IO.Path]::GetFullPath((Join-Path $tempRoot ('codex-scheduler-package-check-' + [Guid]::NewGuid().ToString('N'))))
if ([System.IO.Path]::GetDirectoryName($extractPath) -ne $tempRoot) { throw '解压验证目录无效。' }
function Read-PayloadHash([string]$filePath) {
  $hashStream = [System.IO.File]::OpenRead($filePath)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($sha.ComputeHash($hashStream)) }
  finally { $sha.Dispose(); $hashStream.Dispose() }
}
try {
  [System.IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $extractPath, [System.Text.Encoding]::UTF8)
  foreach ($entryName in $expected) {
    $source = Join-Path $root $entryName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $extracted = Join-Path $extractPath $entryName.Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $sourceHash = Read-PayloadHash $source
    $extractedHash = Read-PayloadHash $extracted
    if ($sourceHash -ne $extractedHash) { throw ('解压内容校验失败：' + $entryName) }
  }
} finally {
  if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($extractPath)) -ne $tempRoot) { throw '解压验证目录清理范围无效。' }
  if (Test-Path -LiteralPath $extractPath) { Remove-Item -LiteralPath $extractPath -Recurse -Force }
}
@{ entries=$expected.Count; cmdNames=$cmdNames; extractionVerified=$true } | ConvertTo-Json -Compress
`;
try {
  await writeDistribution(root, { files });
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let stdout;
  try { ({ stdout } = await promisify(execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { cwd: root, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 })); }
  catch (error) { throw new Error(String(error.stderr || 'ZIP 打包未完成。').trim()); }
  const verified = JSON.parse(stdout.trim());
  if (!verified.extractionVerified) throw new Error('ZIP 解压验证未完成。');
  await fs.rename(temporary, target);
  console.log(`ZIP 已通过 UTF-8 文件名与全部 ${verified.entries} 个文件的解压校验。`);
} finally {
  await fs.unlink(temporary).catch(() => {});
  if (!path.basename(root).startsWith('codex-scheduler-distribution-') || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('分发临时目录清理范围无效。');
  await fs.rm(root, { recursive: true, force: true });
}
console.log(target);
