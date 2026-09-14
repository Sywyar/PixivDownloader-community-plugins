# PixivDownloader community plugins

[简体中文](README.md)

Submit a PixivDownloader plugin for review here. With public source and a built plugin package ready, run the submission wizard from your source project to open a review PR. You do not need to clone this repository or write submission files by hand.

> Submissions and reviews are available. Community signing, marketplace publication and the execution of version management requests are not connected yet. Approval or merging a PR does not currently list a plugin in the marketplace.

## Submissions and version management

### 1. Prepare the source and package

- Develop with the [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK), push the source to a public GitHub repository and keep the working tree clean. Commit the license and the SDK project's `.pixivdownloader-plugin-project` marker.
- Build and test with the project's Maven, Gradle or sbt setup, and keep the final JAR / ZIP. Its version must match the project version, and its behavior declarations must match the code. The wizard reads this information; it does not build the plugin for you.
- Upload that package to a public Release in the source repository. Prereleases can use Pre-release, but the Release must not remain a Draft. A public HTTPS download URL is also accepted. The local and downloaded packages must be identical. Do not replace an existing version's assets.

The community rebuilds from the submitted source and compares package bytes. Pin build tools, dependencies and packaging timestamps to avoid differences between local and community builds.

### 2. Set up your tools

Install Git, GitHub CLI, Node.js 24+ and JDK 17, with `java`, `javac` and `jar` available in the terminal. Use Windows PowerShell 5.1 or PowerShell 7. When setting up GitHub CLI for the first time, run:

```powershell
gh auth login
gh auth setup-git
```

Configure Git's `user.name` and `user.email` for commits as well.

### 3. Run the submission wizard

Open your SDK project directory, replacing the example path below:

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submit.ps1' | iex
```

Follow the prompts:

1. Choose version submission, the project, build profile and final package. After you confirm that you trust the local project, the wizard calls the build tool to read project information.
2. Check the plugin version, behavior declarations and license. Choose your GitHub publisher identity and enter the plugin description and other display information.
3. Select an existing signing key or generate one, then select the uploaded Release asset or enter its download URL. The wizard compares the public and local packages and creates the submission signature.
4. Review the full preview and choose "Confirm and continue". The wizard then creates a fork if needed, commits and pushes the submission files, and opens a review PR.

Store private keys outside Git repositories and temporary directories, and keep a backup for future versions. To change a version or behavior declaration inside the package, edit the source, rebuild and upload the package again.

Use arrow keys to move, Enter to select, Space to toggle tags, and Esc or Ctrl+C to cancel. Confirmations default to cancellation. Nothing is submitted to GitHub before the final confirmation.

### 4. Wait for review

Follow check results and review comments in the PR. The community validates the submission, rebuilds the package, scans its declarations and performs human review. Waiting for review does not require another build. Changes to source, packages or build inputs require rebuilding and renewed review.

For an update, prepare the new version's source and package, then use the same entry point. Key rotation, yanking, unyanking, revocation and ownership transfer have separate management options in the wizard.

## Help and maintenance

Ask submission questions in [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues). See the [contribution guide](CONTRIBUTING.md) for review forms and repository maintenance. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain their declared licenses.
