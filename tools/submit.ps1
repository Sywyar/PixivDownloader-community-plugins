param([string]$ProjectDirectory = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$LauncherPath = $MyInvocation.MyCommand.Path
$SubmitExitCode = 0
$SubmitFailure = $null
$DownloadClient = $null
$BootstrapMessages = if ([Globalization.CultureInfo]::CurrentUICulture.Name -like 'zh*') {
    ConvertFrom-Json '{"activity":"\u51c6\u5907\u6295\u7a3f\u5de5\u5177","retry":"\u4e0b\u8f7d {0} \u4e2d\u65ad\uff08{1}\uff09\uff0c\u6b63\u5728\u91cd\u8bd5 {2}/{3}","failed":"{0}: \u4e0b\u8f7d {1} \u5931\u8d25\uff1b\u9636\u6bb5={2}\uff0c\u539f\u56e0={3}\uff0c\u5df2\u5c1d\u8bd5={4}\uff0c\u6bcf\u8f6e\u6700\u591a={5}\uff1b\u505c\u6b62\u539f\u56e0\uff1a{6}","deadlineExpired":"\u672c\u8f6e\u603b\u65f6\u95f4\u5df2\u8017\u5c3d","attemptsExhausted":"\u672c\u8f6e\u5c1d\u8bd5\u6b21\u6570\u5df2\u8017\u5c3d","notRetryable":"\u6b64\u9519\u8bef\u4e0d\u80fd\u91cd\u8bd5","resume":"\u662f\u5426\u91cd\u65b0\u4e0b\u8f7d\u5f53\u524d\u6587\u4ef6\uff1f\u5df2\u6821\u9a8c\u7684\u7f13\u5b58\u4f1a\u4fdd\u7559\u3002","retryChoice":"\u91cd\u65b0\u5c1d\u8bd5(&R)","exitChoice":"\u9000\u51fa(&E)","round":"; \u8f6e\u6b21={0}, \u7d2f\u8ba1\u5c1d\u8bd5={1}"}'
} else {
    ConvertFrom-Json '{"activity":"Preparing submission tools","retry":"Download of {0} interrupted ({1}); retrying {2}/{3}","failed":"{0}: download of {1} failed; stage={2}, reason={3}, attempts={4}, maximum per round={5}; stopped: {6}","deadlineExpired":"total time for this round exhausted","attemptsExhausted":"attempt limit for this round exhausted","notRetryable":"this error cannot be retried","resume":"Download the current file again? Verified cache files will be kept.","retryChoice":"&Retry","exitChoice":"&Exit","round":"; round={0}, total attempts={1}"}'
}

$Repository = 'Sywyar/PixivDownloader-community-plugins'
$ChannelUrl = 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submission-channel.json'
$ChannelPublicKey = 'MCowBQYDK2VwAyEAEice6eR3ukN2iDCNDF+sQsNaLgPEamv7TNy/6DKV07c='
$RuntimeCommit = $null
$ManifestSha256 = $null
$ChannelLock = $null
$ChannelVerifier = @'
const crypto = require('node:crypto');

const CHANNEL = 'pixivdownloader-community-submission-v1';
const REPOSITORY = 'Sywyar/PixivDownloader-community-plugins';
const MAX_BYTES = 4096;
const MAX_AGE = 90 * 24 * 60 * 60;
const CLOCK_SKEW = 300;

function fail(code) { throw new Error('BOOTSTRAP_CHANNEL_' + code); }

function base64(value, maximum = MAX_BYTES) {
    if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4) fail('INVALID');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > maximum || bytes.toString('base64') !== value) fail('INVALID');
    return bytes;
}

function document(bytes, keys) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('SIZE_EXCEEDED');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { fail('INVALID'); }
    if (!value || Array.isArray(value) || typeof value !== 'object'
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
        || !Buffer.from(JSON.stringify(value)).equals(bytes)) fail('INVALID');
    return value;
}

function publicKey(spki) {
    const bytes = base64(spki);
    if (bytes.length !== 44 || bytes.subarray(0, 12).toString('hex') !== '302a300506032b6570032100') fail('KEY_INVALID');
    return crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' });
}

function verifyEnvelope(bytes, spki, now, checkTime = true) {
    const envelope = document(bytes, ['payload', 'signature']);
    const payloadBytes = base64(envelope.payload);
    const signature = base64(envelope.signature);
    if (signature.length !== 64 || !crypto.verify(null, payloadBytes, publicKey(spki), signature)) fail('SIGNATURE_INVALID');
    const payload = document(payloadBytes, ['schemaVersion', 'channel', 'repository', 'sequence', 'runtimeCommit', 'manifestSha256', 'issuedAt', 'expiresAt']);
    if (payload.schemaVersion !== 1 || payload.channel !== CHANNEL || payload.repository !== REPOSITORY
        || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1
        || typeof payload.runtimeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(payload.runtimeCommit) || /^0+$/.test(payload.runtimeCommit)
        || typeof payload.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(payload.manifestSha256) || /^0+$/.test(payload.manifestSha256)
        || !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 1
        || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= payload.issuedAt
        || payload.expiresAt - payload.issuedAt > MAX_AGE) fail('INVALID');
    if (checkTime && (!Number.isSafeInteger(now) || payload.issuedAt > now + CLOCK_SKEW)) fail('NOT_YET_VALID');
    if (checkTime && payload.expiresAt <= now) fail('EXPIRED');
    return payload;
}

function selectChannel(bytes, previous, spki, now = Math.floor(Date.now() / 1000)) {
    const current = verifyEnvelope(bytes, spki, now);
    if (previous) {
        const prior = verifyEnvelope(previous, spki, now, false);
        if (current.sequence < prior.sequence || current.issuedAt < prior.issuedAt) fail('ROLLBACK');
        if (current.sequence === prior.sequence && !bytes.equals(previous)) fail('SEQUENCE_CONFLICT');
    }
    return current;
}

function signChannel(payload, privateKey) {
    const key = crypto.createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') fail('KEY_INVALID');
    const bytes = Buffer.from(JSON.stringify(payload));
    const envelope = Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, key).toString('base64') }));
    verifyEnvelope(envelope, crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64'), payload.issuedAt);
    return envelope;
}

module.exports = { CHANNEL, REPOSITORY, MAX_BYTES, MAX_AGE, CLOCK_SKEW, base64, publicKey, verifyEnvelope, selectChannel, signChannel };

if (process.argv[1] === 'verify-channel') {
    try {
        if (process.argv.length !== 5) fail('ARGUMENTS');
        const current = selectChannel(base64(process.argv[2]), process.argv[3] === '-' ? null : base64(process.argv[3]), process.argv[4]);
        process.stdout.write(JSON.stringify(current));
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
'@
$MarkerName = '.pixivdownloader-plugin-project'
# Keep this entry ASCII for both -File and irm | iex on PowerShell 5.1.
$MarkerMissing = ConvertFrom-Json '"\u672a\u68c0\u6d4b\u5230\u9879\u76ee\u6807\u8bc6\uff0c\u60a8\u7684SDK\u7248\u672c\u53ef\u80fd\u4f4e\u4e8e3600837c\u6216\u975eSDK\u76ee\u5f55"'

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

function New-DownloadClient {
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    return [Net.Http.HttpClient]::new($handler)
}

function Get-DownloadFailure($Failure) {
    $reason = 'NETWORK_ERROR'
    $retryable = $false
    $tls = $false
    while ($Failure) {
        if ($Failure -is [OperationCanceledException]) { return @{ Reason = 'TIMEOUT'; Retryable = $false } }
        if ($Failure -is [Security.Authentication.AuthenticationException]) { $tls = $true }
        if ($Failure -is [IO.IOException]) { $reason = 'TRANSFER_INTERRUPTED'; $retryable = $true }
        if ($Failure -is [Net.Sockets.SocketException]) {
            $reason = 'SOCKET_' + $Failure.SocketErrorCode
            $retryable = $Failure.SocketErrorCode -in @('ConnectionAborted', 'ConnectionRefused', 'ConnectionReset', 'HostDown', 'HostNotFound', 'HostUnreachable', 'NetworkDown', 'NetworkReset', 'NetworkUnreachable', 'NoData', 'TimedOut', 'TryAgain')
        }
        if ($Failure -is [Net.WebException]) {
            if ($Failure.Status -eq 'TrustFailure') { return @{ Reason = 'TLS_REJECTED'; Retryable = $false } }
            $reason = 'WEB_' + $Failure.Status
            $retryable = $Failure.Status -in @('ConnectFailure', 'ConnectionClosed', 'KeepAliveFailure', 'NameResolutionFailure', 'ProxyNameResolutionFailure', 'ReceiveFailure', 'SendFailure', 'Timeout')
        }
        if ($Failure.PSObject.Properties['HttpRequestError']) {
            $reason = [string]$Failure.HttpRequestError
            if ($reason -eq 'SecureConnectionError') { $tls = $true }
            $retryable = $reason -in @('NameResolutionError', 'ConnectionError', 'ResponseEnded')
        }
        $Failure = $Failure.InnerException
    }
    if ($tls) { $reason = if ($retryable) { 'TLS_INTERRUPTED' } else { 'TLS_REJECTED' } }
    return @{ Reason = $reason; Retryable = $retryable }
}

function Confirm-DownloadRetry([string]$Message) {
    if ([Console]::IsInputRedirected -or [Environment]::GetCommandLineArgs() -contains '-NonInteractive') { return $false }
    Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Completed
    [Console]::Error.WriteLine($Message)
    try {
        $choices = [Management.Automation.Host.ChoiceDescription[]]@($BootstrapMessages.retryChoice, $BootstrapMessages.exitChoice)
        return $Host.UI.PromptForChoice('', $BootstrapMessages.resume, $choices, 1) -eq 0
    } catch { return $false }
}

function Download-Pinned([string]$Url, [string]$File, [long]$Maximum, $Client) {
    # Only the signed channel is mutable data; executable files require a verified commit and digest.
    $prefix = 'https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/'
    if ($Url -cne $ChannelUrl -and (-not $RuntimeCommit -or -not $Url.StartsWith($prefix, [StringComparison]::Ordinal))) { throw 'BOOTSTRAP_URL_INVALID' }
    $resource = if ($Url -ceq $ChannelUrl) { 'tools/submission-channel.json' } else { $Url.Substring($prefix.Length) }
    $attempts = 3
    $round = 0
    $totalAttempts = 0
    while ($true) {
        $round++
        $deadline = [Threading.CancellationTokenSource]::new(60000)
        try {
            for ($attempt = 1; $attempt -le $attempts; $attempt++) {
                $totalAttempts++
                $response = $null; $inputStream = $null; $outputStream = $null
                $created = $false; $failure = $null; $code = 'BOOTSTRAP_DOWNLOAD_FAILED'; $stage = 'connect'
                $operation = [Threading.CancellationTokenSource]::CreateLinkedTokenSource($deadline.Token)
                try {
                    Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Status $resource
                    $operation.CancelAfter(15000)
                    $response = $Client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $operation.Token).GetAwaiter().GetResult()
                    $stage = 'headers'
                    $status = [int]$response.StatusCode
                    if ($status -ne 200) {
                        $failure = @{ Reason = 'HTTP_' + $status; Retryable = $status -in @(408, 500, 502, 503, 504) }
                        throw 'BOOTSTRAP_DOWNLOAD_FAILED'
                    }
                    if ($response.Content.Headers.ContentLength -gt $Maximum) { $code = 'BOOTSTRAP_SIZE_EXCEEDED'; throw $code }
                    $stage = 'read'
                    $operation.CancelAfter(15000)
                    $streamTask = $response.Content.ReadAsStreamAsync()
                    $streamTask.Wait($operation.Token)
                    $inputStream = $streamTask.GetAwaiter().GetResult()
                    $stage = 'write'
                    $outputStream = [IO.File]::Open($File, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
                    $created = $true
                    $buffer = New-Object byte[] 8192
                    [long]$total = 0
                    while ($true) {
                        $stage = 'read'
                        $operation.CancelAfter(15000)
                        $readTask = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $operation.Token)
                        $readTask.Wait($operation.Token)
                        $count = $readTask.GetAwaiter().GetResult()
                        if ($count -eq 0) { break }
                        $total += $count
                        if ($total -gt $Maximum) { $code = 'BOOTSTRAP_SIZE_EXCEEDED'; throw $code }
                        $stage = 'write'
                        $outputStream.Write($buffer, 0, $count)
                    }
                    if ($null -ne $response.Content.Headers.ContentLength -and $total -ne $response.Content.Headers.ContentLength) { throw [IO.IOException]::new('Incomplete response') }
                    return
                } catch {
                    if (-not $failure) {
                        $failure = if ($stage -in @('connect', 'read')) { Get-DownloadFailure $_.Exception } else { @{ Reason = 'LOCAL_IO'; Retryable = $false } }
                    }
                    if ($failure.Reason -eq 'TIMEOUT' -and $operation.IsCancellationRequested) {
                        $failure = @{ Reason = $(if ($deadline.IsCancellationRequested) { 'TIMEOUT' } else { 'IDLE_TIMEOUT' }); Retryable = $true }
                    }
                    if ($code -ne 'BOOTSTRAP_DOWNLOAD_FAILED') { $failure = @{ Reason = $code; Retryable = $false } }
                } finally {
                    if ($outputStream) { $outputStream.Dispose() }
                    if ($inputStream) { $inputStream.Dispose() }
                    if ($response) { $response.Dispose() }
                    $operation.Dispose()
                }
                if ($created) { Assert-PlainPath $File; [IO.File]::Delete($File) }
                if ($failure.Retryable -and $attempt -lt $attempts -and -not $deadline.IsCancellationRequested) {
                    [Console]::Error.WriteLine(($BootstrapMessages.retry -f $resource, $failure.Reason, ($attempt + 1), $attempts))
                    if (-not $deadline.Token.WaitHandle.WaitOne(1000 * $attempt)) { continue }
                }
                $stopReason = if (-not $failure.Retryable) { 'notRetryable' } elseif ($deadline.IsCancellationRequested) { 'deadlineExpired' } else { 'attemptsExhausted' }
                break
            }
        } finally { $deadline.Dispose() }
        $message = $BootstrapMessages.failed -f $code, $resource, $stage, $failure.Reason, $attempt, $attempts, $BootstrapMessages.$stopReason
        $message += $BootstrapMessages.round -f $round, $totalAttempts
        if (-not $failure.Retryable -or -not (Confirm-DownloadRetry $message)) { throw $message }
    }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'REQUIRED_TOOL_MISSING: git' }
    $project = Confirm-Project $ProjectDirectory
    foreach ($command in @('node', 'java', 'javac', 'jar', 'gh')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw ('REQUIRED_TOOL_MISSING: ' + $command) }
    }
    $nodeVersion = & node --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'NODE_24_REQUIRED' }
    $DownloadClient = New-DownloadClient
    $cacheBase = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'PixivDownloader', 'community-tools')
    Assert-PlainPath $cacheBase
    [IO.Directory]::CreateDirectory($cacheBase) | Out-Null
    $keyHasher = [Security.Cryptography.SHA256]::Create()
    try { $keyHash = [BitConverter]::ToString($keyHasher.ComputeHash([Convert]::FromBase64String($ChannelPublicKey))).Replace('-', '').ToLowerInvariant() }
    finally { $keyHasher.Dispose() }
    $stateFile = [IO.Path]::Combine($cacheBase, 'channel-v1-' + $keyHash + '.json')
    $lockFile = $stateFile + '.lock'
    Assert-PlainPath $stateFile
    Assert-PlainPath $lockFile
    try { $ChannelLock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'BOOTSTRAP_CHANNEL_BUSY' }
    $temporaryChannel = $stateFile + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Status 'tools/submission-channel.json'
        Download-Pinned $ChannelUrl $temporaryChannel 4096 $DownloadClient
        $channelBytes = Read-Bounded $temporaryChannel 4096
        $priorChannel = if (Test-Path -LiteralPath $stateFile) { [Convert]::ToBase64String((Read-Bounded $stateFile 4096)) } else { '-' }
        $verifyArgs = @('-e', $ChannelVerifier, 'verify-channel', [Convert]::ToBase64String($channelBytes), $priorChannel, $ChannelPublicKey)
        $verified = & node @verifyArgs
        if ($LASTEXITCODE -ne 0) { throw 'BOOTSTRAP_CHANNEL_REJECTED' }
        $selectedChannel = ([string]::Join('', @($verified))) | ConvertFrom-Json
        $RuntimeCommit = $selectedChannel.runtimeCommit
        $ManifestSha256 = $selectedChannel.manifestSha256
        Assert-PlainPath $stateFile
        if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace($temporaryChannel, $stateFile, [NullString]::Value) }
        else { [IO.File]::Move($temporaryChannel, $stateFile) }
    } finally {
        Assert-PlainPath $temporaryChannel
        [IO.File]::Delete($temporaryChannel)
    }
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
                Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Status 'tools/submission-files.json'
                Download-Pinned ('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/tools/submission-files.json') $temporaryManifest 65536 $DownloadClient
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
    $completed = 0
    foreach ($file in $manifest.files) {
        if ($file.path -notmatch '^(scripts|tools|schemas)/[A-Za-z0-9._/-]+$' -or $file.path -match '(^|/)\.\.?(/|$)' -or
            $seen.ContainsKey($file.path) -or $file.sha256 -notmatch '^[0-9a-f]{64}$' -or $file.size -lt 1 -or $file.size -ne [long]$file.size) { throw 'BOOTSTRAP_MANIFEST_INVALID' }
        $seen[$file.path] = $true
        $total += $file.size
        if ($total -gt 67108864) { throw 'BOOTSTRAP_SIZE_EXCEEDED' }
        $completed++
        Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Status (('{0}/{1} ' -f $completed, $manifest.files.Count) + $file.path) -PercentComplete ([int](100 * ($completed - 1) / $manifest.files.Count))
        $destination = [IO.Path]::Combine($cache, $file.path)
        Assert-PlainPath $destination
        if (File-Matches $destination $file.size $file.sha256) { continue }
        if (Test-Path -LiteralPath $destination) { throw 'BOOTSTRAP_FILE_CHANGED' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        $localFile = if ($localRoot) { [IO.Path]::Combine($localRoot, $file.path) } else { $null }
        $temporaryFile = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            if ($localFile -and (File-Matches $localFile $file.size $file.sha256)) { [IO.File]::WriteAllBytes($temporaryFile, (Read-Bounded $localFile $file.size)) }
            else { Download-Pinned ('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/' + $file.path) $temporaryFile $file.size $DownloadClient }
            if (-not (File-Matches $temporaryFile $file.size $file.sha256)) { throw 'BOOTSTRAP_FILE_CHANGED' }
            if (-not (File-Matches $destination $file.size $file.sha256)) { [IO.File]::Move($temporaryFile, $destination) }
        } finally {
            # Remove only this invocation's temporary file inside the checked cache.
            Assert-PlainPath $temporaryFile
            [IO.File]::Delete($temporaryFile)
        }
    }
    if (-not $seen.ContainsKey('scripts/submit.mjs')) { throw 'BOOTSTRAP_ENTRY_MISSING' }
    $verified = & node @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw 'BOOTSTRAP_CHANNEL_REJECTED' }
    Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Completed
    $DownloadClient.Dispose()
    $DownloadClient = $null
    $ChannelLock.Dispose()
    $ChannelLock = $null
    $nodeArgs = @([IO.Path]::Combine($cache, 'scripts', 'submit.mjs'), $project)
    & node @nodeArgs
    $SubmitExitCode = $LASTEXITCODE
} catch {
    $SubmitFailure = $_.Exception.GetBaseException().Message
    if ($LauncherPath) { [Console]::Error.WriteLine($SubmitFailure) }
    $SubmitExitCode = 1
} finally {
    if ($ChannelLock) { $ChannelLock.Dispose() }
    if ($DownloadClient) { $DownloadClient.Dispose() }
    Write-Progress -Id 1 -Activity $BootstrapMessages.activity -Completed
}
# Preserve native exit codes; report pipeline failures without exiting the user's terminal.
$global:LASTEXITCODE = $SubmitExitCode
if ($LauncherPath) { exit $SubmitExitCode }
if ($SubmitExitCode -ne 0) {
    if (-not $SubmitFailure) { $SubmitFailure = 'SUBMISSION_FAILED: ' + $SubmitExitCode }
    throw $SubmitFailure
}
