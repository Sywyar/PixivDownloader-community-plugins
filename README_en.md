# PixivDownloader community plugins

[简体中文](README.md)

This repository stores plugin submissions, publisher identities, review evidence, and publication records. Publishers supply public source at a fixed commit and a signed package. The community build compares its output byte for byte with that package and archives it with the evidence in a Draft Release here.

Version submissions require static validation, an isolated rebuild, risk review and human review of the current head. Only the repository owner may submit maintenance PRs for tools, rules and documentation. Community signing, public catalog publication and management operation executors are not connected. Approval or merging a PR does not publish a plugin.

A community signature records the review and byte verification of a particular version. It does not guarantee that a plugin is free of vulnerabilities or malicious behavior. Developer capability declarations come from `pixiv.risk-signals` inside the package. An execution mode is not an operating system sandbox.

Ordinary contributors use fork pull requests without repository write access. Submission data, repository maintenance, and protected publication results follow separate paths. Only the repository owner may merge. See [the contribution guide](CONTRIBUTING.md).

## Submissions and version management

Install Git, GitHub CLI, Node.js 24 or newer, and JDK 17 with `java`, `javac` and `jar` on your path. Sign in with `gh` and configure your Git commit identity and GitHub HTTPS authentication. In Windows PowerShell 5.1 or PowerShell 7, open your SDK project directory and run the pinned launcher:

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/30697cc721024224295ae79edb11b6ae1660c5cf/tools/submit.ps1' | iex
```

You do not need to clone the community repository. `irm` retrieves the launcher from the fixed commit above. The launcher then verifies tools against a full source commit and manifest SHA-256. It checks each file before using the cache at `%LOCALAPPDATA%\PixivDownloader\community-tools`, downloading missing files only from that commit. Downloads follow the platform's default proxy settings, without cookies, default credentials or redirects. It does not execute tools from a mutable branch.

When the wizard finishes, its result code is stored in `$LASTEXITCODE`. With `irm | iex`, failures throw an error without closing the interactive terminal. Calling scripts can handle the error with `try/catch` and read the result code. Running a saved launcher with PowerShell `-File` returns that code as the process exit code.

To keep a local copy, download the same URL and run `.\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`. In a trusted full checkout, you can also run `.\tools\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`.

`ProjectDirectory` can point to an SDK project or a Git root containing several SDK projects. The launcher first checks the Git-tracked `.pixivdownloader-plugin-project` marker. If it is missing, the launcher exits with this message, meaning that the SDK may predate commit `3600837c` or the directory may not be an SDK project:

> 未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录

The wizard offers Simplified Chinese, Traditional Chinese, English, Japanese and Korean. A version submission requires a clean, publicly available source commit, a built plugin package, and a public HTTPS download URL or GitHub Release asset with identical bytes. After you select the project and build profile, the wizard asks whether you trust the project before running Maven, Gradle or sbt to query its actual model. This query can execute project configuration and build plugins with your local account's permissions. It needs no container and does not build the plugin for you.

The wizard reads versions, digests and identities from the model, final package and native GitHub data, and identifies first publications and updates. Risk declarations come from `pixiv.risk-signals` inside the package; changing them requires rebuilding from source. You confirm the license, publisher name, market text and authority to represent an organization. If the project lacks a license, the wizard can write a pinned license text; commit the source and rebuild before submitting again.

Selecting a different key for an existing publisher generates a separate key-rotation request. The main menu also supports YANK, UNYANK, REVOKE and ownership transfer. UNYANK refers to the currently effective YANK decision; transfer parties use their own accounts to submit a proposal or approval. Store generated keys and existing private keys outside Git repositories and temporary directories, and keep your own backup.

The final preview includes the identity, target fork, branch, every file's path and digest, JSON contents and PR details. After you select “Confirm and continue” and press Enter, the wizard rechecks the account, base, binding and contents, then creates the fork if needed, commits, pushes normally and opens a Ready PR. Cancelling the preview makes no GitHub writes. You may rerun after an interruption; existing content is reused only when it matches exactly. The wizard never approves or merges a PR. Key, status and transfer requests still require their protected executors.

The wizard uses Clack prompts. Use arrow keys to move, Enter to select, Space to toggle tags, and Esc or Ctrl+C to cancel. Text defaults are editable. Required fields, HTTPS URLs and key paths can be corrected at the current prompt. Loading steps show their status, and the final confirmation includes a summary and complete preview. Confirmations for project execution, key generation, organization authority and submission default to “Cancel”. Use arrow keys to select “Confirm and continue”, then press Enter; pressing Enter alone does not authorize the operation. Optional signature proof is skipped by default.

Run `npm run submit:demo` from a trusted source checkout to try the same interaction components with sample data. The demo makes no GitHub requests, runs no builds, performs no signing and writes no files. To run the actual wizard from source, use `node scripts/submit.mjs 'D:\Plugins\example'`. This command performs the normal project checks and submission flow.

Clack and its runtime dependencies are bundled into the pinned tool manifest, so submitting requires no npm installation. Maintainers updating dependencies run `npm ci --ignore-scripts`, `npm run bundle:ui` and `node scripts/submission-manifest.mjs --write`. Run `node scripts/bundle-submission-ui.mjs --check` to check the bundle against the lockfile. The generated file includes third-party licenses. Publishing a launcher requires pinning both the tool source commit and manifest digest, then pinning the tutorial's `irm` URL to the actual commit containing that launcher.

## Builds and review

`Submission static check` runs the exact protected workflow source commit. It first reads the PR's native identity, base/head and added Git blobs, then checks paths, the pinned SDK schemas, source archives, public package sizes and digests, publisher signatures and static images. This validation only parses data; candidate code never enters the checker's classpath.

Version submissions then build on a disposable GitHub-hosted Ubuntu runner. The container image is pinned by digest, with limits of 2 CPUs, 6 GiB of memory, 12 GiB of writable disk, 512 processes and 30 minutes per build. Maven, Gradle and sbt profiles run their build and test tasks. Prefetching uses a proxy restricted to approved public artifact sources; the final rebuild restores the original source and disables networking. The container receives no secrets, GitHub tokens, Docker socket or shared writable cache. Its output must match the publisher's original package byte for byte.

The prefetch proxy uses Ubuntu OpenSSL tools pinned by SHA-256. It checks destinations in CONNECT, TLS and HTTP requests, forwards only HTTPS GET/HEAD requests to approved hosts, and verifies origin certificates. Build containers receive read-only access to the temporary CA certificate and trust store. Only the proxy receives its private key, which is removed at the end of the run. Developer and runner system trust stores are unchanged.

The scanner reads JVM call instructions in the final package without loading plugin classes. Reports retain exact method symbols, locations, package digests and original call evidence, distinguishing plugin compiler outputs, private dependencies and classes whose origin is unknown. Only direct calls covered by the rules can produce missing-declaration findings; no match does not prove that a behavior is absent. Invalid classes or scan failures yield `INCOMPLETE` while retaining known findings. The SBOM inventories actual packages and build-cache files. Declared dependency licenses still require human review.

The build job has read permissions and no secrets. It hands the package, source and evidence to an Actions artifact retained for seven days. The protected `Community candidate archive` verifies native execution provenance and every file, then stores them in a pending-review Draft Release with a GitHub artifact attestation of the archive source. Package asset names include the stable publisher ID, for example `pixivdownload-plugin-alice-example-plugin-1.2.0.jar`. Drafts remain outside the public catalog and do not grant `SOURCE_REVIEWED`.

Waiting for review or retrying reuses verified archive bytes. A new head requires new review. Source, package or build-input changes require a rebuild; scanner-rule changes may reuse the package and rescan it. Missing archives, conflicting digests or unverifiable provenance block progress. Native Request changes remains blocking. Self-review, false-positive decisions and manual scan acceptance use separate protected form actions described in the [contribution guide](CONTRIBUTING.md).

Key rotation, version status and ownership transfer are separate operations and cannot share a PR with a version submission.

Protected operation processes append audits at `audits/<requestId>.json`. Status queries verify the referenced request and decision bytes; UNYANK refers only to the currently effective YANK decision. Ownership recovery evidence uses `ownership-transfer-evidence/<pluginId>/<sha256>.bin`, with the digest taken from the original bytes.

Run `npm test` with Node.js 24, JDK 17, Git, and GitHub CLI installed. `npm run repository:plan` prints the target settings; `npm run labels:plan` reads the current labels and prints the changes. Neither command writes to GitHub.

Tests use the pinned SDK tool and resources in this repository without downloading Maven dependencies. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain the licenses declared by their publishers.

`tools/signing-tool.json` separately pins the publisher signing CLI's source commit, JAR size and SHA-256. It supports key generation, public-key export and operation signing. The pinned SDK and cryptographic verifier remain unchanged. Private keys must stay outside source repositories and temporary directories and must never enter a submission, PR or artifact.
