param([string]$ProjectDirectory = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$LauncherPath = $MyInvocation.MyCommand.Path
$SubmitExitCode = 0

# 固定工具闭包；更新时同时固定来源提交和清单原始摘要。
$RuntimeCommit = 'e5489ee3180a3bc339f9aba47f01e1e86155b88d'
$ManifestSha256 = 'bf9148ede485a140982e64b1dc45eec94cdc3fd8904fb7c22af5f96f16f48c6d'
$Repository = 'Sywyar/PixivDownloader-community-plugins'
$MarkerName = '.pixivdownloader-plugin-project'
$MarkerMissing = '未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录'

function Assert-PlainPath([string]$Value) {
    $current = [IO.Path]::GetFullPath($Value)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'BOOTSTRAP_LINK_REJECTED' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Read-Bounded([string]$File, [long]$Maximum) {
    Assert-PlainPath $File
    $stream = [IO.File]::OpenRead($File)
    try {
        if ($stream.Length -gt $Maximum) { throw 'BOOTSTRAP_SIZE_EXCEEDED' }
        $bytes = New-Object byte[] ([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($count -eq 0) { throw 'BOOTSTRAP_FILE_CHANGED' }
            $offset += $count
        }
        if ($stream.ReadByte() -ne -1) { throw 'BOOTSTRAP_FILE_CHANGED' }
        return ,$bytes
    } finally { $stream.Dispose() }
}

function Confirm-Project([string]$Directory) {
    $resolved = (Get-Item -LiteralPath $Directory -Force).FullName
    Assert-PlainPath $resolved
    try {
        $gitArgs = @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $resolved, 'rev-parse', '--show-toplevel')
        $gitRoot = & git @gitArgs 2>$null
        if ($LASTEXITCODE -ne 0) { throw $MarkerMissing }
        $gitRoot = [IO.Path]::GetFullPath([string]$gitRoot)
    } catch { throw $MarkerMissing }
    $gitArgs = @('--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', $gitRoot, 'ls-files', '--stage', '-z', '--', (':(glob)**/' + $MarkerName))
    $output = & git @gitArgs
    if ($LASTEXITCODE -ne 0) { throw 'PROJECT_MARKER_INVALID' }
    $found = $false
    foreach ($record in ([string]::Join("`n", @($output))).Split([char]0)) {
        if (-not $record) { continue }
        if ($record -notmatch '^100(?:644|755) [0-9a-f]{40}(?:[0-9a-f]{24})? 0\t(.+)$') { throw 'PROJECT_MARKER_INVALID' }
        $marker = [IO.Path]::GetFullPath([IO.Path]::Combine($gitRoot, $Matches[1]))
        if (-not $marker.StartsWith($gitRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'PROJECT_MARKER_INVALID' }
        $text = [Text.UTF8Encoding]::new($false, $true).GetString((Read-Bounded $marker ([Text.Encoding]::UTF8.GetByteCount('pixivdownloader-plugin-project-v1') + 5)))
        if ($text -notmatch '^\uFEFF?pixivdownloader-plugin-project-v1(?:\r?\n)?$') { throw 'PROJECT_MARKER_INVALID' }
        $project = [IO.Path]::GetDirectoryName($marker)
        if ($project -eq $resolved -or $resolved -eq $gitRoot) { $found = $true }
    }
    if (-not $found) { throw $MarkerMissing }
    return $resolved
}

function File-Matches([string]$File, [long]$Size, [string]$Digest) {
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    Assert-PlainPath $File
    if ((Get-Item -LiteralPath $File -Force).Length -ne $Size) { return $false }
    return (File-Digest $File $Size) -eq $Digest
}

function File-Digest([string]$File, [long]$Maximum) {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha256.ComputeHash((Read-Bounded $File $Maximum))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
}

function Download-Pinned([string]$Url, [string]$File, [long]$Maximum) {
    # 只访问固定 GitHub raw 路径，不转发凭据、Cookie 或代理，也不接受重定向。
    if (-not $Url.StartsWith(('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/'), [StringComparison]::Ordinal)) { throw 'BOOTSTRAP_URL_INVALID' }
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $handler.UseProxy = $false
    $handler.UseDefaultCredentials = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $deadline = [Threading.CancellationTokenSource]::new(60000)
    try {
        $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
        try {
            if ([int]$response.StatusCode -ne 200) { throw 'BOOTSTRAP_DOWNLOAD_FAILED' }
            if ($response.Content.Headers.ContentLength -gt $Maximum) { throw 'BOOTSTRAP_SIZE_EXCEEDED' }
            $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $outputStream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
            try {
                $buffer = New-Object byte[] 8192
                [long]$total = 0
                while (($count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $deadline.Token).GetAwaiter().GetResult()) -gt 0) {
                    $total += $count
                    if ($total -gt $Maximum) { throw 'BOOTSTRAP_SIZE_EXCEEDED' }
                    $outputStream.Write($buffer, 0, $count)
                }
            } finally { $outputStream.Dispose(); $inputStream.Dispose() }
        } finally { $response.Dispose() }
    } finally { $deadline.Dispose(); $client.Dispose(); $handler.Dispose() }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'REQUIRED_TOOL_MISSING: git' }
    $project = Confirm-Project $ProjectDirectory
    foreach ($command in @('node', 'java', 'javac', 'jar', 'gh')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw ('REQUIRED_TOOL_MISSING: ' + $command) }
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'NODE_24_REQUIRED' }
    if ($RuntimeCommit -eq ('0' * 40) -or $ManifestSha256 -eq ('0' * 64)) { throw 'BOOTSTRAP_PIN_UNSET' }
    $cacheBase = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'PixivDownloader', 'community-tools')
    Assert-PlainPath $cacheBase
    [IO.Directory]::CreateDirectory($cacheBase) | Out-Null
    $localRoot = if ($LauncherPath) { [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($LauncherPath)) } else { $null }
    $manifestFile = [IO.Path]::Combine($cacheBase, $ManifestSha256 + '.json')
    Assert-PlainPath $manifestFile
    if (-not (Test-Path -LiteralPath $manifestFile)) {
        $temporaryManifest = $manifestFile + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        $localManifest = if ($localRoot) { [IO.Path]::Combine($localRoot, 'tools', 'submission-files.json') } else { $null }
        try {
            if ($localManifest -and (Test-Path -LiteralPath $localManifest -PathType Leaf) -and
                (File-Digest $localManifest 65536) -eq $ManifestSha256) {
                [IO.File]::WriteAllBytes($temporaryManifest, (Read-Bounded $localManifest 65536))
            } else {
                Download-Pinned ('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/tools/submission-files.json') $temporaryManifest 65536
            }
            if ((File-Digest $temporaryManifest 65536) -ne $ManifestSha256) { throw 'BOOTSTRAP_MANIFEST_CHANGED' }
            if (-not (Test-Path -LiteralPath $manifestFile)) { [IO.File]::Move($temporaryManifest, $manifestFile) }
        } finally {
            Assert-PlainPath $temporaryManifest
            [IO.File]::Delete($temporaryManifest)
        }
    }
    if ((File-Digest $manifestFile 65536) -ne $ManifestSha256) { throw 'BOOTSTRAP_MANIFEST_CHANGED' }
    $manifest = [Text.UTF8Encoding]::new($false, $true).GetString((Read-Bounded $manifestFile 65536)) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.files.Count -lt 1 -or $manifest.files.Count -gt 256) { throw 'BOOTSTRAP_MANIFEST_INVALID' }
    $cache = [IO.Path]::Combine($cacheBase, $ManifestSha256.Substring(0, 16))
    Assert-PlainPath $cache
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $seen = @{}
    [long]$total = 0
    foreach ($file in $manifest.files) {
        if ($file.path -notmatch '^(scripts|tools|schemas)/[A-Za-z0-9._/-]+$' -or $file.path -match '(^|/)\.\.?(/|$)' -or
            $seen.ContainsKey($file.path) -or $file.sha256 -notmatch '^[0-9a-f]{64}$' -or $file.size -lt 1 -or $file.size -ne [long]$file.size) { throw 'BOOTSTRAP_MANIFEST_INVALID' }
        $seen[$file.path] = $true
        $total += $file.size
        if ($total -gt 67108864) { throw 'BOOTSTRAP_SIZE_EXCEEDED' }
        $destination = [IO.Path]::Combine($cache, $file.path)
        Assert-PlainPath $destination
        if (File-Matches $destination $file.size $file.sha256) { continue }
        if (Test-Path -LiteralPath $destination) { throw 'BOOTSTRAP_FILE_CHANGED' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        $localFile = if ($localRoot) { [IO.Path]::Combine($localRoot, $file.path) } else { $null }
        $temporaryFile = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            if ($localFile -and (File-Matches $localFile $file.size $file.sha256)) { [IO.File]::WriteAllBytes($temporaryFile, (Read-Bounded $localFile $file.size)) }
            else { Download-Pinned ('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/' + $file.path) $temporaryFile $file.size }
            if (-not (File-Matches $temporaryFile $file.size $file.sha256)) { throw 'BOOTSTRAP_FILE_CHANGED' }
            if (-not (File-Matches $destination $file.size $file.sha256)) { [IO.File]::Move($temporaryFile, $destination) }
        } finally {
            # 临时文件由本次生成，目标仍在已验证的缓存目录中；失败下载不占用正式缓存名。
            Assert-PlainPath $temporaryFile
            [IO.File]::Delete($temporaryFile)
        }
    }
    if (-not $seen.ContainsKey('scripts/submit.mjs')) { throw 'BOOTSTRAP_ENTRY_MISSING' }
    $nodeArgs = @([IO.Path]::Combine($cache, 'scripts', 'submit.mjs'), $project)
    & node @nodeArgs
    $SubmitExitCode = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $SubmitExitCode = 1
}
# irm | iex 返回调用终端；直接运行脚本时继续向父进程传递退出码。
$global:LASTEXITCODE = $SubmitExitCode
if ($LauncherPath) { exit $SubmitExitCode }
