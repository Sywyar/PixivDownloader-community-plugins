# PixivDownloader community plugins

[简体中文](README.md)

This repository stores plugin submissions, publisher identities, review evidence, and publication records. Plugin source and packages remain in the publisher's source repository and fixed release assets.

**Admission currently accepts only repository-owner PRs for tools, rules and documentation.** Data PRs have an independent static check. Source review, isolated rebuilding and signing are not connected, so passing static checks does not unblock admission.

A community signature records the review and byte verification of a particular version. It does not guarantee that a plugin is free of vulnerabilities or malicious behavior. Developer capability declarations come from `pixiv.risk-signals` inside the package. An execution mode is not an operating system sandbox.

Ordinary contributors use fork pull requests without repository write access. Submission data, repository maintenance, and protected publication results follow separate paths. Only the repository owner may merge. See [the contribution guide](CONTRIBUTING.md).

## Submissions and version management

Install Git, GitHub CLI, Node.js 24 or newer, and JDK 17 with `java`, `javac` and `jar` on your path. Sign in with `gh` and configure your Git commit identity and GitHub HTTPS authentication. In Windows PowerShell 5.1 or PowerShell 7, open your SDK project directory and run the pinned launcher:

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/97aa09a469748719fb365065cff81e432ab89032/tools/submit.ps1' | iex
```

You do not need to clone the community repository. `irm` retrieves the launcher from the fixed commit above. The launcher then verifies tools against a full source commit and manifest SHA-256. It checks each file before using the cache at `%LOCALAPPDATA%\PixivDownloader\community-tools`, downloading missing files only from that commit. It does not execute tools from a mutable branch. When the wizard finishes, it returns to your terminal and leaves the result code in `$LASTEXITCODE`.

To keep a local copy, download the same URL and run `.\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`. In a trusted full checkout, you can also run `.\tools\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`.

`ProjectDirectory` can point to an SDK project or a Git root containing several SDK projects. The launcher first checks the Git-tracked `.pixivdownloader-plugin-project` marker. If it is missing, the launcher exits with this message, meaning that the SDK may predate commit `3600837c` or the directory may not be an SDK project:

> 未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录

The wizard offers Simplified Chinese, Traditional Chinese, English, Japanese and Korean. A version submission requires a clean, publicly available source commit, a built plugin package, and a public HTTPS download URL or GitHub Release asset with identical bytes. After you select the project and build profile, the wizard asks whether you trust the project before running Maven, Gradle or sbt to query its actual model. This query can execute project configuration and build plugins with your local account's permissions. It needs no container and does not build the plugin for you.

The wizard reads versions, digests and identities from the model, final package and native GitHub data, and identifies first publications and updates. Risk declarations come from `pixiv.risk-signals` inside the package; changing them requires rebuilding from source. You confirm the license, publisher name, market text and authority to represent an organization. If the project lacks a license, the wizard can write a pinned license text; commit the source and rebuild before submitting again.

Selecting a different key for an existing publisher generates a separate key-rotation request. The main menu also supports YANK, UNYANK, REVOKE and ownership transfer. UNYANK refers to the currently effective YANK decision; transfer parties use their own accounts to submit a proposal or approval. Store generated keys and existing private keys outside Git repositories and temporary directories, and keep your own backup.

The final preview includes the identity, target fork, branch, every file's path and digest, JSON contents and PR details. After you enter `YES`, the wizard rechecks the account, base, binding and contents, then creates the fork if needed, commits, pushes normally and opens a Ready PR. Cancelling the preview makes no GitHub writes. You may rerun after an interruption; existing content is reused only when it matches exactly. The wizard never approves or merges a PR. Data admission remains subject to the restriction at the top of this page.

## Static checks

`Submission static check` runs the exact protected workflow source commit. It reads the PR's native identity, base/head and added Git blobs, then independently checks paths, the pinned SDK schemas, source archives, public package sizes and digests, publisher signatures and static images. Candidate code never enters the classpath, and the check does not run Maven, Gradle or sbt.

The job has read permissions and no secrets. Successful checks retain static inputs for seven days. `STATIC_VALIDATED` does not grant source-review assurance or publication rights. Key rotation, version status and ownership transfer are separate operations and cannot share a PR with a version submission.

Protected operation processes append audits at `audits/<requestId>.json`. Status queries verify the referenced request and decision bytes; UNYANK refers only to the currently effective YANK decision. Ownership recovery evidence uses `ownership-transfer-evidence/<pluginId>/<sha256>.bin`, with the digest taken from the original bytes.

Run `npm test` with Node.js 24, JDK 17, Git, and GitHub CLI installed. `npm run repository:plan` prints the target settings; `npm run labels:plan` reads the current labels and prints the changes. Neither command writes to GitHub.

Tests use the pinned SDK tool and resources in this repository without downloading Maven dependencies. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain the licenses declared by their publishers.

`tools/signing-tool.json` separately pins the publisher signing CLI's source commit, JAR size and SHA-256. It supports key generation, public-key export and operation signing. The pinned SDK and cryptographic verifier remain unchanged. Private keys must stay outside source repositories and temporary directories and must never enter a submission, PR or artifact.
