# PixivDownloader community plugins

[简体中文](README.md)

Submit a PixivDownloader plugin for review here. Push your public source to GitHub, wait for the candidate CI to pass, then run the wizard from your source project. You do not need to clone this repository or write submission files by hand.

After review, a maintainer generates publication data in the original request PR. Merging it triggers the community Release update. A source candidate Release or a community Draft under review does not grant community admission.

## Submissions and version management

### 1. Push the source and wait for CI

- Develop with the [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK), commit your license, and retain the SDK project marker and candidate workflow.
- Push to the public repository's default branch and wait for every **Plugin candidate** job to pass. CI tests the plugin, checks offline reproduction, and reuses one Draft Release per plugin, replacing its previous candidate assets.
- Keep your working tree clean and run the wizard from that same commit. You do not need to download CI artifacts or create a Release yourself. Older SDK projects need updated tools and the candidate workflow first.

The community rebuilds from the submitted source and compares package bytes. Pin build tools, dependencies and packaging timestamps to avoid differences between local and community builds.

### 2. Set up your tools

Install Git, GitHub CLI, Node.js 24+ and JDK 17, with `java`, `javac` and `jar` available in the terminal. Use Windows PowerShell 5.1 or PowerShell 7. When setting up GitHub CLI for the first time, run:

```powershell
gh auth login
gh auth setup-git
```

Configure Git's `user.name` and `user.email` for commits as well.

On Windows, package and source downloads use the system proxy unless `HTTPS_PROXY` is set in the terminal. Use `NO_PROXY` to select destinations that should connect directly. HTTP and HTTPS proxies are supported. Download errors include a code and failure stage to distinguish connection problems from file digest mismatches.

### 3. Run the submission wizard

Open your SDK project directory, replacing the example path below:

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submit.ps1' | iex
```

Follow the prompts:

1. Choose version submission. A single project and build tool are detected automatically; choose when there are multiple options. The wizard retrieves this commit's CI candidate and verifies its bytes.
2. Check the plugin version, behavior declarations and license. Choose your GitHub publisher identity and enter the plugin description and other display information.
3. Select an existing signing key or generate one. To generate a key, select an existing parent folder; the tool creates its own subfolder. You can protect the private key with a password.
4. Confirm the submission summary, then review the full preview and metadata changes. After confirmation, the wizard saves the verified candidate in a pre-release tied to the source commit, creates a fork if needed, and commits and submits the review PR. Later CI builds reuse the Draft without overwriting submitted packages.

Store private keys outside Git repositories and temporary directories, and keep a backup. Encrypted keys require a password when signing is needed; the wizard does not save passwords. After changing a version, behavior declaration or source license, commit and push the changes, then wait for the new CI run before continuing.

Use arrow keys to move, Enter to select, Space to toggle tags, Ctrl+B to go back, Ctrl+S to save and exit, and Esc or Ctrl+C to cancel. Optional fields can be cleared. Every remote write is shown for confirmation beforehand; confirmation defaults to cancellation.

Saved answers and verified packages stay in your user folder, separated by source repository, project directory, plugin ID and GitHub account. On Windows, the default location is `%LOCALAPPDATA%\PixivDownloader\community-submission\projects\`. The next run asks whether to continue, using your last selected language. Choose Yes to resume the unfinished submission, or No to start the normal flow with saved details and key paths available as defaults. If signed content only needs submission, the wizard verifies its signatures without asking for the password again. Changes to the account, source or community base prompt you to start again.

Long operations show temporary substeps that disappear when complete. Temporary GitHub read failures retry automatically; if a request still fails, you can retry or save and exit. When a write response is lost, the wizard checks the remote result before continuing.

Draft Releases remain available after Actions artifacts expire. The Draft holds only the latest candidate; if its archive is missing, the wizard can rerun CI for the current default-branch commit after confirmation. Fixed candidates from confirmed submissions remain available.

The license step accepts existing files or creates a new file from a bundled template. Existing files are preserved. A recognized complete template preselects its SPDX identifier; combined licenses still require confirmation. After creating or changing a license, commit, push and wait for new CI.

### 4. Wait for review

Follow check results and review comments in the PR. The community validates the submission, rebuilds the package, scans its declarations and performs human review. Waiting for review does not require another build. Changes to source, packages or build inputs require rebuilding and renewed review.

For an update, change the version, push and wait for CI, then use the same entry point. The wizard restores license and marketplace details, preserves existing languages and images, and checks for duplicate IDs and versions early. Key rotation, yanking, unyanking, revocation and ownership transfer have separate management options.

- To withdraw a request, choose the withdrawal operation and confirm closing your unmerged PR. For a merged request that has not been applied, ask a maintainer to pause execution.
- YANK blocks new installations. UNYANK removes your own yank after the issue is resolved; independent community restrictions remain effective.
- REVOKE blocks installation and startup and cannot be undone. Clients enforce the revocation protocols they support.
- For key rotation, select the publisher and a new key. A lost old key requires recovery review.
- For a transfer, the recipient creates a request using their own key, then the current maintainer selects and approves that request in the wizard. Neither party needs to share a private key. Recovery evidence and separate review are required when the current maintainer cannot approve.

Management requests also require review and protected execution. Formal Release names retain the original publisher; their descriptions show the current maintainer and status. Package bytes, historical signatures and original authorship remain unchanged. If no item is eligible, the wizard explains why and returns to the operation menu.

## Help and maintenance

Ask submission questions in [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues). See the [contribution guide](CONTRIBUTING.md) for review forms and repository maintenance. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain their declared licenses.
