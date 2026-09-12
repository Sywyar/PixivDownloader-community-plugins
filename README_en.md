# PixivDownloader community plugins

[简体中文](README.md)

This repository stores plugin submissions, publisher identities, review evidence, and publication records. Plugin source and packages remain in the publisher's source repository and fixed release assets.

**Admission currently accepts only repository-owner PRs for tools, rules and documentation.** Data PRs have an independent static check. Source review, isolated rebuilding and signing are not connected, so passing static checks does not unblock admission.

A community signature records the review and byte verification of a particular version. It does not guarantee that a plugin is free of vulnerabilities or malicious behavior. Developer capability declarations come from `pixiv.risk-signals` inside the package. An execution mode is not an operating system sandbox.

Ordinary contributors use fork pull requests without repository write access. Submission data, repository maintenance, and protected publication results follow separate paths. Only the repository owner may merge. See [the contribution guide](CONTRIBUTING.md).

## Static checks

`Submission static check` runs the exact protected workflow source commit. It reads the PR's native identity, base/head and added Git blobs, then independently checks paths, the pinned SDK schemas, source archives, public package sizes and digests, publisher signatures and static images. Candidate code never enters the classpath, and the check does not run Maven, Gradle or sbt.

The job has read permissions and no secrets. Successful checks retain static inputs for seven days. `STATIC_VALIDATED` does not grant source-review assurance or publication rights. Key rotation, version status and ownership transfer are separate operations and cannot share a PR with a version submission.

Protected operation processes append audits at `audits/<requestId>.json`. Status queries verify the referenced request and decision bytes; UNYANK refers only to the currently effective YANK decision. Ownership recovery evidence uses `ownership-transfer-evidence/<pluginId>/<sha256>.bin`, with the digest taken from the original bytes.

Run `npm test` with Node.js 24, JDK 17, Git, and GitHub CLI installed. `npm run repository:plan` prints the target settings; `npm run labels:plan` reads the current labels and prints the changes. Neither command writes to GitHub.

Tests use the pinned SDK tool and resources in this repository without downloading Maven dependencies. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain the licenses declared by their publishers.

`tools/signing-tool.json` separately pins the publisher signing CLI's source commit, JAR size and SHA-256. It supports key generation, public-key export and operation signing. The pinned SDK and cryptographic verifier remain unchanged. Private keys must stay outside source repositories and temporary directories and must never enter a submission, PR or artifact.
