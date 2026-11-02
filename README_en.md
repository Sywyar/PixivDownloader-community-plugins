# PixivDownloader Community Plugins

[简体中文](README.md)

This repository receives and publishes open-source community plugins for PixivDownloader. Push your plugin source to a public GitHub repository, wait for candidate CI to pass, and run the submission wizard directly from your SDK project directory. You do not need to clone this repository or write submission files by hand.

- First submission or new version release: see [Submissions and version management](#submissions-and-version-management).
- Yank, unyank, revoke, rotate keys, declare key compromise, or transfer ownership: see [Manage registered plugins](#manage-registered-plugins).
- Repository maintenance and review workflows: see [CONTRIBUTING.md](CONTRIBUTING.md).

For an ordinary version submission, once a maintainer submits a native `Approve` review on the current PR head, the protected workflow waits for static checks, isolated rebuild, and candidate archival, generates signed catalog data, verifies all four Gate checks, merges the PR, and publishes the community Release. Neither a source candidate Draft Release nor a community Draft under review constitutes community admission.

## Open-source admission

This official community repository accepts only open-source plugins. Every submitted version must:

1. **Provide complete, reproducible source code**: Publish the exact source commit and build inputs in a public, non-archived GitHub repository so the community isolated build environment can reproduce and verify the package bytes. A downloadable JAR, ZIP, or Release alone is not accepted.
2. **Include an open-source license**: Provide a license meeting the [OSI Open Source Definition](https://opensource.org/osd) (such as MIT) and required copyright notices covering the submitted code and artifact, compatible with all dependency obligations. SPDX syntax and digest checks only validate formatting; custom or combined licenses and compatibility remain subject to human review.

## Submissions and version management

### 1. Push source and wait for candidate CI

1. Develop your plugin with the [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK), commit your license file, and keep the SDK project marker and `Plugin candidate` workflow (upgrade older SDK projects first if needed).
2. Push to your public repository's default branch and wait for all **Plugin candidate** jobs to pass (CI runs tests, verifies offline reproduction, and updates a single reusable Draft Release per plugin).
3. Keep your local working tree clean, pin build tools, dependencies, and packaging timestamps, and launch the wizard from that exact commit.

### 2. Prepare your local environment

Install Git (with `user.name` and `user.email` configured), GitHub CLI, Node.js 24+, and JDK 17+ (ensure `java`, `javac`, and `jar` on `PATH` come from JDK 17+). Sign in to GitHub CLI in Windows PowerShell 5.1 or PowerShell 7:

```powershell
gh auth login
gh auth setup-git
```

- **Workflow scope**: If pushing reports `GIT_WORKFLOW_SCOPE_REQUIRED`, your Git credentials lack workflow write permission. For GitHub CLI OAuth, run `gh auth refresh --hostname github.com --scopes workflow`; for a classic PAT, add `workflow`; for a fine-grained PAT, grant `Workflows: write`.
- **Proxy and tool cache**: Downloads honor `NO_PROXY`, `HTTPS_PROXY` / `ALL_PROXY`, or the Windows system HTTP/HTTPS proxy. On first run, the wizard downloads and verifies pinned technical dependencies from the signed channel without downloading the full SDK archive, and reuses the verified cache on subsequent runs.

### 3. Run the submission wizard

From your SDK project directory (replace the path with your actual project folder):

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submit.ps1' | iex
```

1. **Select version submission**: The wizard detects your project and fetches the CI candidate for the current commit (falling back to the Draft Release if Actions artifacts expired, or offering to rerun CI on confirmation).
2. **Verify metadata and license**: Confirm the plugin version, behavior declarations, SPDX license (use an existing file or generate one from a bundled template), publisher identity, and localized marketplace descriptions, category, and tags.
3. **Sign the artifact**: Choose an existing Ed25519 private key or generate a new key pair (keep private keys outside Git repositories and temporary folders and back them up; passphrases are never stored by the wizard).
4. **Preview and submit**: Confirm the summary and full diff preview. The wizard promotes the verified candidate to a commit-bound Pre-release in your source repository, prepares your fork and branch, and opens the review PR.

**Navigation and saved progress**: Use arrow keys to move, `Enter` to confirm, `Space` to toggle tags, `Ctrl+B` to go back, `Ctrl+S` to save and exit, and `Esc` / `Ctrl+C` to cancel. Every remote write requires explicit confirmation (defaulting to cancel). Unfinished progress is isolated by account, repository, project, and plugin ID under `%LOCALAPPDATA%\PixivDownloader\community-submission\projects\` (with publisher key records under `publishers\`). If community mainline advances during your session, the wizard automatically reloads and revalidates state (up to 3 recovery rounds per operation).

### 4. Attach marketplace docs, images, and links (optional)

- **Links and release notes**: Configure homepage, docs, issue tracker, or custom links. By default, the wizard extracts release notes from the matching `## [vX.Y.Z]` section of `CHANGELOG.md` in the frozen source commit, and can also attach the full `CHANGELOG.md`. If the section is missing or duplicated, select another file, enter notes manually, or skip them.
- **README and images**: Supply optional UTF-8 Markdown or HTML from frozen source, a local file, or multiline input (`Enter` for newline, `Tab` then `Enter` to submit). Relative images must reside within the selected root; external HTTPS images require download confirmation.
- **Verification**: Confirmed documents and images are staged in a `market-content-<plugin>-<version>` Release in your source repository, verified by SHA-256 during review, and published alongside the plugin package in the community Release. Publication also verifies that the files can be downloaded publicly. The marketplace displays sanitized, static documents in isolation.

### 5. Wait for review and publish updates

Track check results and review feedback in your PR. Waiting for review requires no rebuild; changing source code, licenses, or build inputs requires pushing a new commit, waiting for CI, and rerunning the wizard. Unrelated mainline data updates are merged automatically by the queue workflow without manual branch syncing. To publish a newer version later, bump the version, push, wait for CI, and run the same wizard command.

## Manage registered plugins

To perform management actions without publishing a new build, run the same `irm ... | iex` command from any directory (progress is stored under `%LOCALAPPDATA%\PixivDownloader\community-submission\management\`):

| Operation | Behavior and authorization |
| --- | --- |
| Withdraw unmerged request | Close your open PR and optionally delete its request branch after confirmation (retaining your fork, default branch, Releases, and local progress) |
| Yank (`YANK`) / Unyank (`UNYANK`) | `YANK` blocks new installations; `UNYANK` lifts a self-initiated yank while keeping independent community restrictions. Requests signed with a personal owner's active key are verified and merged automatically |
| Revoke version (`REVOKE`) | Permanently blocks installation and startup (irreversible; requires typing `pluginId@version`) and removes the public package asset after archival. Automatically applied when signed with a personal owner's active key |
| Key rotation (`ROUTINE_ROTATION`) | Personal accounts providing signatures from both the old and new private keys are processed automatically (retiring the old key); lost/compromised keys or organization accounts require human review |
| Declare key compromise | Select registered public keys (no private key needed) to submit to the protected `emergency-state` branch. Automatically applied for the personal owner or a verified organization admin, immediately blocking those public keys from new or pending operations. This cannot be undone; if your active key is blocked, rotate it before submitting again |
| Ownership transfer | The recipient enters `currentPublisherId/pluginId` (e.g., `sywyar/douyin`) and opens a transfer PR; the current owner approves (signing with their active key for automatic merge between personal accounts, or submitting a web Approve for human review) or rejects in the wizard. If an expected transfer PR is not listed, choose "Change filters" at the bottom of the list to clear the label or `@mention` filter |

An effective native `Request changes` review still blocks automatic processing of management requests. Signature proofs cannot override human objections or independent community restrictions.

## Help and licensing

Open an [Issue](https://github.com/Sywyar/PixivDownloader-community-plugins/issues) for submission questions. Repository governance and wizard tools are licensed under [AGPL-3.0-or-later](LICENSE); individual plugins remain under their declared open-source licenses.
