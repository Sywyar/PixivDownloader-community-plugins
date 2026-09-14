param([string]$ProjectDirectory = (Get-Location).Path)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$LauncherPath = $MyInvocation.MyCommand.Path
$SubmitExitCode = 0
$SubmitFailure = $null

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

function Download-Pinned([string]$Url, [string]$File, [long]$Maximum) {
    # Only the signed channel is mutable data; executable files require a verified commit and digest.
    if ($Url -cne $ChannelUrl -and (-not $RuntimeCommit -or -not $Url.StartsWith(('https://raw.githubusercontent.com/' + $Repository + '/' + $RuntimeCommit + '/'), [StringComparison]::Ordinal))) { throw 'BOOTSTRAP_URL_INVALID' }
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
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
        Download-Pinned $ChannelUrl $temporaryChannel 4096
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
            # Remove only this invocation's temporary file inside the checked cache.
            Assert-PlainPath $temporaryFile
            [IO.File]::Delete($temporaryFile)
        }
    }
    if (-not $seen.ContainsKey('scripts/submit.mjs')) { throw 'BOOTSTRAP_ENTRY_MISSING' }
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
}
# Preserve native exit codes; report pipeline failures without exiting the user's terminal.
$global:LASTEXITCODE = $SubmitExitCode
if ($LauncherPath) { exit $SubmitExitCode }
if ($SubmitExitCode -ne 0) {
    if (-not $SubmitFailure) { $SubmitFailure = 'SUBMISSION_FAILED: ' + $SubmitExitCode }
    throw $SubmitFailure
}
