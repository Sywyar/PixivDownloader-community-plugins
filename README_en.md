# PixivDownloader community plugins

[简体中文](README.md)

Submit a PixivDownloader plugin for review here. Push your public source to GitHub, wait for the candidate CI to pass, then run the wizard from your source project. You do not need to clone this repository or write submission files by hand.

> Submissions and reviews are available. Community signing, marketplace publication and the execution of version management requests are not connected yet. Approval or merging a PR does not currently list a plugin in the marketplace.

## Submissions and version management

### 1. Push the source and wait for CI

- Develop with the [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK), commit your license, and retain the SDK project marker and candidate workflow.
- Push to the public repository's default branch and wait for every **Plugin candidate** job to pass. CI tests the plugin, checks offline reproduction, and archives the package in a source repository Draft Release.
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
4. Confirm the submission summary, then review the full preview and metadata changes. After confirmation, the wizard publishes the source candidate as a pre-release awaiting review, creates a fork if needed, and commits and submits the review PR.

Store private keys outside Git repositories and temporary directories, and keep a backup. Encrypted keys require a password when signing is needed; the wizard does not save passwords. After changing a version, behavior declaration or source license, commit and push the changes, then wait for the new CI run before continuing.

Use arrow keys to move, Enter to select, Space to toggle tags, Ctrl+B to go back, Ctrl+S to save and exit, and Esc or Ctrl+C to cancel. Optional fields can be cleared. Every remote write is shown for confirmation beforehand; confirmation defaults to cancellation.

Saved answers and verified packages stay in your user folder, separated by source repository, project directory, plugin ID and GitHub account. On Windows, the default location is `%LOCALAPPDATA%\PixivDownloader\community-submission\projects\`. The next run asks whether to continue, using your last selected language. Choose Yes to resume the unfinished submission, or No to start the normal flow with saved details and key paths available as defaults. If signed content only needs submission, the wizard verifies its signatures without asking for the password again. Changes to the account, source or community base prompt you to start again.

Long operations show temporary substeps that disappear when complete. Temporary GitHub read failures retry automatically; if a request still fails, you can retry or save and exit. When a write response is lost, the wizard checks the remote result before continuing.

Draft Releases remain available after Actions artifacts expire. If an archive is missing, the wizard can rerun the original CI for this commit after confirmation.

### 4. Wait for review

Follow check results and review comments in the PR. The community validates the submission, rebuilds the package, scans its declarations and performs human review. Waiting for review does not require another build. Changes to source, packages or build inputs require rebuilding and renewed review.

For an update, change the version, push and wait for CI, then use the same entry point. The wizard restores license and marketplace details, preserves existing languages and images, and checks for duplicate IDs and versions early. Key rotation, yanking, unyanking, revocation and ownership transfer have separate management options.

## Help and maintenance

Ask submission questions in [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues). See the [contribution guide](CONTRIBUTING.md) for review forms and repository maintenance. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain their declared licenses.
