# PixivDownloader community plugins

[简体中文](README.md)

This repository stores plugin submissions, publisher identities, review evidence, and publication records. Plugin source and packages remain in the publisher's source repository and fixed release assets.

**Only repository-owner PRs for tools, rules and documentation are currently accepted.** Plugin submissions, scan decisions and signing are unavailable; those requests remain blocked.

A community signature records the review and byte verification of a particular version. It does not guarantee that a plugin is free of vulnerabilities or malicious behavior. Developer capability declarations come from `pixiv.risk-signals` inside the package. An execution mode is not an operating system sandbox.

Ordinary contributors use fork pull requests without repository write access. Submission data, repository maintenance, and protected publication results follow separate paths. Only the repository owner may merge. See [the contribution guide](CONTRIBUTING.md).

Run `npm test` with Node.js 24, JDK 17, Git, and GitHub CLI installed. `npm run repository:plan` prints the target settings; `npm run labels:plan` reads the current labels and prints the changes. Neither command writes to GitHub.

Tests use the pinned SDK tool and resources in this repository without downloading Maven dependencies. Repository tools use [AGPL-3.0-or-later](LICENSE); plugins retain the licenses declared by their publishers.
