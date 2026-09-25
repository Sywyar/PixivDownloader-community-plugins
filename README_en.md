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

Install Git, GitHub CLI, Node.js 24+ and JDK 17 or newer. The terminal's `java`, `javac` and `jar` must each come from JDK 17+. The wizard checks them individually and identifies the tool, step and cause when a version is too old or execution fails. Use Windows PowerShell 5.1 or PowerShell 7. When setting up GitHub CLI for the first time, run:

```powershell
gh auth login
gh auth setup-git
```

Configure Git's `user.name` and `user.email` for commits as well.

If a push reports `GIT_WORKFLOW_SCOPE_REQUIRED`, the credentials used by Git lack permission to write workflows. This can also happen when the submission branch includes workflow updates from the community's default branch. For GitHub CLI OAuth login credentials, run `gh auth refresh --hostname github.com --scopes workflow` in the same authentication environment, then continue in the wizard or save and exit. For a classic PAT, grant the `workflow` scope; for a fine-grained PAT or GitHub App, grant `Workflows: write`. Update the credentials actually used by Git.

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

Saved answers and verified packages stay in your user folder, separated by source repository, project directory, plugin ID and GitHub account. On Windows, the default location is `%LOCALAPPDATA%\PixivDownloader\community-submission\projects\`. The next run asks whether to continue, using your last selected language. Choose Yes to resume the unfinished submission, or No to start the normal flow with saved details as defaults. If signed content only needs submission, the wizard verifies its signatures without asking for the password again. An updated community branch triggers validation against its current state; account or source changes require starting again.

Key location records use the adjacent `publishers\` directory. Projects for the same publisher share these records, separated by the acting GitHub account. The public key fingerprint selects the keyId and paths. Each use verifies the actual key pair before updating the record. A keyId is an independently generated identifier; registered keys retain their community identifier. Missing files produce an error without searching other directories. Passwords and private key contents are never cached.

For community management, the same command also works from an ordinary directory. Without a project marker, the wizard explains that only management options are available; publishing or updating still requires an SDK project. Management progress is stored by signed-in account in the sibling `management\` directory, while key records remain shared by publisher.

Long operations show temporary substeps that disappear when complete. Transient network failures allow up to three automatic attempts within the time budget. Further failures show the specific step, current round and total attempts; you can retry that step or save and exit. Completed steps are retained. Before retrying a write with a lost response, the wizard reads back the same PR, branch or candidate asset. Certificate, digest, identity and local file errors do not trigger automatic retries.

Draft Releases remain available after Actions artifacts expire. The Draft holds only the latest candidate; if its archive is missing, the wizard can rerun CI for the current default-branch commit after confirmation. Fixed candidates from confirmed submissions remain available.

The license step accepts existing files or creates a new file from a bundled template. Existing files are preserved. A recognized complete template preselects its SPDX identifier; combined licenses still require confirmation. After creating or changing a license, commit, push and wait for new CI.

### 4. Wait for review

Follow check results and review comments in the PR. The community validates the submission, rebuilds the package, scans its declarations and performs human review. Waiting for review does not require another build. Changes to source, packages or build inputs require rebuilding and renewed review.

Requests are prepared and merged through a shared queue. Unrelated mainline data updates do not require contributors to sync their branches: the workflow keeps the reviewed head, includes the latest mainline in the generated commit, and verifies all four admission checks. Changes to the request, ownership, keys or review rules stop processing for renewed validation.

For an update, change the version, push and wait for CI, then use the same entry point. The wizard restores license and marketplace details, preserves existing languages and images, and checks for duplicate IDs and versions early. Key rotation, yanking, unyanking, revocation and ownership transfer have separate management options.

The key list shows registration state, compromise declarations, current plugin owners and restrictions on historically signed versions separately. A transfer ends the previous publisher's management rights for that plugin without retiring their active key. Restoring an old request keeps its original record and shows current ownership or keys. Open requests identify drafts and stale assumptions caused by changes such as rotation or transfer. Stale transfer requests remain available to inspect their reasons and original PR, but cannot be approved in the wizard.

A registered version's ACTIVE, YANKED or REVOKED state is shown separately from Release availability. The availability check compares GitHub Release and package asset metadata only; failed reads or hidden objects leave availability unconfirmed. An UNYANK preview shows the resulting effective state and any independent community restrictions that remain.

- To withdraw a request, confirm closing your unmerged PR, then separately choose whether to delete its request branch. Every deletion requires fresh confirmation. Branches with new commits, protection rules or another open PR are kept. Authors clean up branches in their own fork; the community owner cleans up submission branches in this repository. The fork, default branch, Releases, keys and saved answers are retained. For a merged request that has not been applied, ask a maintainer to pause execution.
- YANK blocks new installations. UNYANK removes your own yank after the issue is resolved; independent community restrictions remain effective.
- REVOKE blocks installation and startup and cannot be undone. Type the selected `pluginId@version` to confirm. Clients enforce the revocation protocols they support.
- For key rotation, select a publisher you may manage and a reason before preparing a new key. Declare suspected compromise through the emergency operation first. Routine rotation for a personal account can proceed automatically with proofs from both keys. Lost or compromised keys and organization accounts still require human review. The registered public key fingerprint supplies the old private key path, which is verified again before use.
- To declare a key compromised, sign in to the owning GitHub account and select the publisher and one or more keys. Each option shows the fingerprint and associated plugins; no private key is needed. The personal owner or a verified organization administrator can use automatic processing. Once merged, the declaration blocks those public keys in new and pending community operations. Published versions remain unchanged. Declarations cannot be undone. If the active key is compromised, complete key rotation before submitting again.
- Transfer: the recipient enters the current owner's `publisherId/pluginId` (for example `sywyar/douyin`), then opens a PR using their own publisher identity and key. The bot mentions the current personal owner in that PR's request-information comments. The owner can approve or reject it in the wizard and sign approval with their active private key, or submit an Approve review on GitHub for human review. The wizard submits an English review and a PR comment linking to it. That comment wakes processing from the default branch, so approval of a first-time contributor's fork workflow does not block notification. An ordinary comment is not consent. After a rejection, the workflow verifies the decision and closes the request without changing ownership. After both parties confirm, results are added to the same PR and merged once. The wizard lists open requests, using both the transfer label and mentions of the current account by default. Filters can be changed at the end of the list. A changed request commit requires fresh confirmation. Never exchange private keys.

For YANK, UNYANK and REVOKE signed with the current personal maintainer's active key, routine personal key rotation proved by both keys, and regular transfers between distinct personal accounts signed by both parties, a protected workflow verifies the request, appends results to the original PR, then merges after checks pass and updates community state. These operations require neither a rebuild nor human approval. Native review objections still block admission. Version publication, missing key proofs, account or key recovery, organization authority and restoration involving independent community restrictions require human review.

The wizard reuses an existing fork and creates each request branch from the current target branch; it does not need to sync the fork's default branch. Compromise declarations use the separate emergency branch; other operations use the community default branch. Temporary Git copies are removed on exit. After exiting, the wizard does not monitor merges or clean up remote branches.

Formal Release names retain the original publisher; their descriptions show the current maintainer and status. Revoked versions retain their Release description, while the public package asset is removed after its archive is verified. Historical signatures and original authorship remain unchanged. If no item is eligible, the wizard explains why and returns to the operation menu.

When looking for transfers to confirm, the wizard defaults to open PRs with both the ownership-transfer label and a mention of your current GitHub account. Labels and mentions may take time to appear. If an expected request is missing, choose “Change filters” at the end of the list and clear either condition before searching again. Organization representatives who were not mentioned can clear that condition too. Broader filters still show only valid requests you may handle.

## Help and maintenance

Ask submission questions in [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues). See the [contribution guide](CONTRIBUTING.md) for review forms and repository maintenance. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain their declared licenses.
