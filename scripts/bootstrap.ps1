param(
    [ValidateSet('install', 'uninstall')][string]$Action = 'install',
    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell children must not inherit PowerShell 7-only module roots.
# This changes only this bootstrap process and its children, never user settings.
$schedulerModuleRoots = @((Join-Path $PSHOME 'Modules'))
$schedulerProgramFiles = [Environment]::GetFolderPath('ProgramFiles')
if (-not [string]::IsNullOrWhiteSpace($schedulerProgramFiles)) {
    $schedulerModuleRoots += Join-Path $schedulerProgramFiles 'WindowsPowerShell\Modules'
}
$env:PSModulePath = $schedulerModuleRoots -join ';'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:SchedulerPackageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function ConvertTo-SchedulerWindowsArchitecture([string]$Native) {
    if ([string]::IsNullOrWhiteSpace($Native)) { throw '无法检测此 Windows 系统的处理器架构。' }
    switch ($Native.ToUpperInvariant()) {
        'AMD64' { return 'x64' }
        'X64' { return 'x64' }
        'ARM64' { return 'arm64' }
        default { throw '此安装包需要 64 位 Windows（x64 或 ARM64）。32 位 Windows 不受支持。' }
    }
}

function Get-SchedulerWindowsArchitecture {
    try {
        $native = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        if (-not [string]::IsNullOrWhiteSpace($native)) { return ConvertTo-SchedulerWindowsArchitecture $native }
    } catch { }
    $native = $env:PROCESSOR_ARCHITEW6432
    if ([string]::IsNullOrWhiteSpace($native)) { $native = $env:PROCESSOR_ARCHITECTURE }
    return ConvertTo-SchedulerWindowsArchitecture $native
}

function Get-SchedulerSha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    # Use .NET directly: a caller launched from PowerShell 7 may carry a
    # PSModulePath that omits Windows PowerShell's Get-FileHash module.
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Read-SchedulerNodeRelease([string]$Root, [string]$Architecture) {
    $metadataPath = Join-Path $Root 'runtime\node-release.json'
    $release = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($release.version -notmatch '^\d+\.\d+\.\d+$' -or [int]($release.version.Split('.')[0]) -lt 22) {
        throw '运行时版本信息无效；请重新下载完整发行包。'
    }
    $key = 'win-' + $Architecture
    $platformProperty = $release.platforms.PSObject.Properties[$key]
    if ($null -eq $platformProperty) { throw ('发行包缺少 ' + $key + ' 运行时信息。') }
    $platform = $platformProperty.Value
    $expectedUrl = 'https://nodejs.org/dist/v' + $release.version + '/' + $key + '/node.exe'
    if ($platform.url -cne $expectedUrl -or $platform.sha256 -notmatch '^[a-fA-F0-9]{64}$') {
        throw '运行时下载地址或校验值无效；未执行任何程序。'
    }
    $expectedLicenseSource = 'https://raw.githubusercontent.com/nodejs/node/v' + $release.version + '/LICENSE'
    if ($release.license.file -cne 'LICENSE.node.txt' -or $release.license.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $release.license.source -cne $expectedLicenseSource) {
        throw '运行时许可证信息无效；请重新下载完整发行包。'
    }
    $licensePath = Join-Path $Root 'runtime\LICENSE.node.txt'
    if ((Get-SchedulerSha256 $licensePath) -cne $release.license.sha256.ToLowerInvariant()) {
        throw '运行时许可证缺失或校验失败；请重新下载并全部解压缩发行包。'
    }
    return @{ Version = $release.version; Architecture = $Architecture; Url = $platform.url;
        Sha256 = $platform.sha256.ToLowerInvariant(); LicenseSha256 = $release.license.sha256.ToLowerInvariant(); LicensePath = $licensePath }
}

function Get-SchedulerInstallationPointer {
    if (-not [string]::IsNullOrWhiteSpace($env:SCHEDULER_DATA_DIR)) { return $null }
    $codexHome = $env:CODEX_HOME
    if ([string]::IsNullOrWhiteSpace($codexHome)) { $codexHome = Join-Path $env:USERPROFILE '.codex' }
    if (-not [IO.Path]::IsPathRooted($codexHome)) { throw 'CODEX_HOME 必须是绝对路径。' }
    $pointerPath = Join-Path $codexHome 'codex-scheduler-install.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { return $null }
    try {
        $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pointer.version -ne 1 -or $pointer.dataDir -isnot [string] -or -not [IO.Path]::IsPathRooted($pointer.dataDir)) { throw 'invalid pointer' }
        return $pointer
    } catch { throw '无法读取时序的本机安装信息；原文件已保留，请先修复该文件。' }
}

function Get-SchedulerRuntimeDirectory($Release, $Pointer) {
    $dataDir = $env:SCHEDULER_DATA_DIR
    if ([string]::IsNullOrWhiteSpace($dataDir) -and $null -ne $Pointer) { $dataDir = $Pointer.dataDir }
    if ([string]::IsNullOrWhiteSpace($dataDir)) {
        $local = $env:LOCALAPPDATA
        if ([string]::IsNullOrWhiteSpace($local)) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
        if ([string]::IsNullOrWhiteSpace($local)) { throw '无法确定当前用户的本地应用数据目录。' }
        $dataDir = Join-Path $local 'CodexScheduler'
    }
    if (-not [IO.Path]::IsPathRooted($dataDir)) { throw 'SCHEDULER_DATA_DIR 必须是绝对路径。' }
    $name = 'node-v' + $Release.Version + '-win-' + $Release.Architecture + '-' + $Release.Sha256.Substring(0, 12)
    return [IO.Path]::GetFullPath((Join-Path (Join-Path $dataDir 'runtime') $name))
}

function Test-SchedulerNode([string]$NodePath, $Release) {
    # No executable is launched until it matches the pinned official hash.
    if ((Get-SchedulerSha256 $NodePath) -cne $Release.Sha256) { return $false }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $NodePath
    $start.Arguments = '-e "console.log(JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform}))"'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables.Remove('NODE_OPTIONS')
    $start.EnvironmentVariables.Remove('NODE_PATH')
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { return $false }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) { $process.Kill(); $process.WaitForExit(); return $false }
        $output = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { return $false }
        $result = $output | ConvertFrom-Json
        return ($result.version -ceq $Release.Version -and $result.arch -ceq $Release.Architecture -and $result.platform -ceq 'win32')
    } catch { return $false }
    finally { $process.Dispose() }
}

function Receive-SchedulerNode([string]$Url, [string]$Destination) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $response = $null
        $downloadStream = $null
        $output = $null
        $retry = $false
        try {
            if ($deadline.Elapsed.TotalSeconds -ge 180) { throw '下载超过总等待时限。' }
            $request = [Net.HttpWebRequest]::Create($Url)
            $request.Method = 'GET'
            $request.AllowAutoRedirect = $false
            $request.Timeout = 30000
            $request.ReadWriteTimeout = 30000
            $request.UserAgent = 'CodexScheduler-RuntimeBootstrap'
            $request.Proxy = [Net.WebRequest]::GetSystemWebProxy()
            if ($null -ne $request.Proxy) { $request.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -ne 200) { throw '下载服务未返回成功状态。' }
            if ($response.ContentLength -gt 134217728) { throw '下载文件超过运行时大小限制。' }
            $downloadStream = $response.GetResponseStream()
            $output = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $buffer = New-Object byte[] 65536
            $total = 0
            while (($read = $downloadStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($deadline.Elapsed.TotalSeconds -ge 180) { throw '下载超过总等待时限。' }
                $total += $read
                if ($total -gt 134217728) { throw '下载文件超过运行时大小限制。' }
                $output.Write($buffer, 0, $read)
            }
            if ($total -eq 0) { throw '运行时下载为空。' }
            return
        } catch {
            if ($attempt -eq 3 -or $deadline.Elapsed.TotalSeconds -ge 180) { throw '无法从 Node.js 官方站点下载运行时。请检查网络或系统代理，或下载对应架构的 Windows 离线包后重新安装。' }
            Write-Host ('运行时下载中断，正在重试（' + $attempt + '/3）…')
            $retry = $true
        } finally {
            if ($null -ne $output) { $output.Dispose() }
            if ($null -ne $downloadStream) { $downloadStream.Dispose() }
            if ($null -ne $response) { $response.Dispose() }
        }
        if ($retry) { Start-Sleep -Seconds $attempt }
    }
}

function Assert-SchedulerSafeWritePath([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '运行时缓存路径包含链接或目录联接；为避免写入其他目录，未执行安装。请改用普通本机用户目录。'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -ceq $current) { break }
        $current = $parent
    }
}

function Install-SchedulerRuntime([string]$Source, [string]$Directory, $Release, [switch]$Download) {
    $runtimeParent = [IO.Path]::GetFullPath((Split-Path -Parent $Directory))
    Assert-SchedulerSafeWritePath $Directory
    $destinationNode = Join-Path $Directory 'node.exe'
    $destinationLicense = Join-Path $Directory 'LICENSE.node.txt'
    if (Test-Path -LiteralPath $Directory) {
        if ((Get-SchedulerSha256 $destinationLicense) -ceq $Release.LicenseSha256 -and (Test-SchedulerNode $destinationNode $Release)) { return $destinationNode }
        throw ('已有运行时缓存不完整或校验失败，未覆盖原目录：' + $Directory + '。请移走该目录后重试。')
    }
    $null = New-Item -ItemType Directory -Path $runtimeParent -Force
    Assert-SchedulerSafeWritePath $runtimeParent
    $temporary = Join-Path $runtimeParent ('.bootstrap-' + [Guid]::NewGuid().ToString('N'))
    $temporaryFull = [IO.Path]::GetFullPath($temporary)
    if ((Split-Path -Parent $temporaryFull) -cne $runtimeParent -or (Split-Path -Leaf $temporaryFull) -notmatch '^\.bootstrap-[a-f0-9]{32}$') {
        throw '无法创建安全的运行时临时目录。'
    }
    $null = New-Item -ItemType Directory -Path $temporaryFull
    try {
        $temporaryNode = Join-Path $temporaryFull 'node.exe'
        if ($Download) {
            Write-Host ('正在从 Node.js 官方站点准备运行时 v' + $Release.Version + '（' + $Release.Architecture + '），无需管理员权限…')
            Receive-SchedulerNode $Release.Url $temporaryNode
        } else { Copy-Item -LiteralPath $Source -Destination $temporaryNode }
        if ((Get-SchedulerSha256 $temporaryNode) -cne $Release.Sha256) { throw 'Node.js 运行时 SHA-256 校验失败；未执行下载或安装包中的程序，请重新下载完整发行包。' }
        Copy-Item -LiteralPath $Release.LicensePath -Destination (Join-Path $temporaryFull 'LICENSE.node.txt')
        if (-not (Test-SchedulerNode $temporaryNode $Release)) { throw '已验证的运行时无法在此 Windows 环境启动，请检查系统版本和安全软件。' }
        Assert-SchedulerSafeWritePath $Directory
        if (Test-Path -LiteralPath $Directory) {
            if ((Get-SchedulerSha256 $destinationLicense) -ceq $Release.LicenseSha256 -and (Test-SchedulerNode $destinationNode $Release)) { return $destinationNode }
            throw '运行时缓存目录在准备期间发生变化；原目录已保留，请重新运行安装。'
        }
        # Publish the two verified files together; an interrupted bootstrap never
        # leaves a half-written runtime at the stable installation path.
        [IO.Directory]::Move($temporaryFull, $Directory)
        if ((Get-SchedulerSha256 $destinationNode) -cne $Release.Sha256) { throw '复制后的运行时校验失败，安装未开始。' }
        return $destinationNode
    } finally {
        # Only the uniquely owned download folder can be recursively removed.
        if ([IO.Path]::GetFullPath($temporaryFull) -ceq $temporaryFull -and (Split-Path -Parent $temporaryFull) -ceq $runtimeParent -and (Split-Path -Leaf $temporaryFull) -match '^\.bootstrap-[a-f0-9]{32}$') {
            if (Test-Path -LiteralPath $temporaryFull) { Assert-SchedulerSafeWritePath $temporaryFull; Remove-Item -LiteralPath $temporaryFull -Recurse -Force }
        }
    }
}

function Resolve-SchedulerNode([string]$Root) {
    $architecture = Get-SchedulerWindowsArchitecture
    $release = Read-SchedulerNodeRelease $Root $architecture
    $pointer = Get-SchedulerInstallationPointer
    $directory = Get-SchedulerRuntimeDirectory $release $pointer
    Assert-SchedulerSafeWritePath $directory
    $bundle = Join-Path $Root ('runtime\windows-' + $architecture + '\node.exe')
    if (Test-Path -LiteralPath $bundle -PathType Leaf) {
        if ((Get-SchedulerSha256 $bundle) -cne $release.Sha256) { throw '离线包中的 Node.js 校验失败；请重新下载对应 Windows 架构的完整离线包。' }
        return Install-SchedulerRuntime $bundle $directory $release
    }
    $cachedNode = Join-Path $directory 'node.exe'
    if ((Get-SchedulerSha256 (Join-Path $directory 'LICENSE.node.txt')) -ceq $release.LicenseSha256 -and (Test-SchedulerNode $cachedNode $release)) { return $cachedNode }
    if ($null -ne $pointer -and $null -ne $pointer.PSObject.Properties['nodePath']) {
        $priorNode = $pointer.nodePath
        if ($priorNode -is [string] -and [IO.Path]::IsPathRooted($priorNode) -and (Get-SchedulerSha256 $priorNode) -ceq $release.Sha256) {
            return Install-SchedulerRuntime $priorNode $directory $release
        }
    }
    foreach ($command in @(Get-Command node.exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
        if ((Get-SchedulerSha256 $command.Source) -ceq $release.Sha256) { return Install-SchedulerRuntime $command.Source $directory $release }
    }
    return Install-SchedulerRuntime '' $directory $release -Download
}

function Invoke-SchedulerBootstrap([string]$Root, [string]$Operation, [bool]$Preview) {
    if ($Preview -and $Operation -ne 'install') { throw '卸载入口不支持 --dry-run；未执行卸载。' }
    $required = @('package.json', '.codex-plugin\plugin.json', '.agents\plugins\marketplace.json',
        ('scripts\' + $Operation + '.mjs'), 'src\paths.mjs', 'src\runtime.mjs', 'runtime\node-release.json', 'runtime\LICENSE.node.txt')
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { throw '操作未执行：安装包不完整。请右键 ZIP 选择“全部解压缩”，打开解压后的文件夹再运行入口。' }
    }
    # Child processes must not inherit unrelated global Node preload settings.
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $nodePath = Resolve-SchedulerNode $Root
    $env:CODEX_SCHEDULER_NODE_PATH = $nodePath
    $entry = Join-Path $Root ('scripts\' + $Operation + '.mjs')
    $formerPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        if ($Preview) { & $nodePath $entry '--dry-run' | Out-Host }
        else { & $nodePath $entry | Out-Host }
        $nodeExitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $formerPreference }
    return $nodeExitCode
}

# Dot sourcing exposes the bounded functions for isolated PS5.1 compatibility
# tests without starting the installer or changing any user's Codex state.
if ($MyInvocation.InvocationName -eq '.') { return }
try { exit (Invoke-SchedulerBootstrap $script:SchedulerPackageRoot $Action ([bool]$DryRun)) }
catch { [Console]::Error.WriteLine(('操作未完成：' + $_.Exception.Message)); exit 1 }
