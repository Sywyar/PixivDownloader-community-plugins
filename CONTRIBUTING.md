# 贡献与维护说明

本指南面向社区仓库维护者，说明许可证审核、独立治理工具维护、检查表单、Environment 凭据配置以及自动/人工发布与恢复流程。插件作者请直接阅读 [README 投稿说明](README.md#投稿与版本管理)。

| 维护任务 | 对应章节 |
| --- | --- |
| 审核开源源码与许可证 | [开源许可证审核](#开源许可证审核) |
| 维护治理工具、签发渠道、仓库保护与标签 | [工具与仓库维护](#工具与仓库维护) |
| 处理 Gate 检查、自审、误报豁免与候选归档 | [检查、裁决表单与候选归档](#检查裁决表单与候选归档) |
| 配置 Environment 密钥、SSH 与合并 PAT | [Environment 与凭据](#environment-与凭据) |
| 执行版本发布、管理请求、紧急封禁与撤销续签 | [完成审核与发布](#完成审核与发布) |

普通投稿者通过自己的 fork 提交投稿 PR；社区所有者使用本仓库内的投稿分支。投稿数据与工具/规则维护必须分属不同 PR，禁止在同一 PR 中同时修改投稿内容与检查器。

## 开源许可证审核

版本准入必须满足 [README 的开源准入要求](README.md#开源准入)。维护者在提交原生 `Approve` 或执行显式自审前，须结合固定源码提交、构建产物及候选 Draft 的 `review-evidence.zip` 核实：

1. 申请 commit 对应的完整源码与构建输入已公开，且隔离构建能够复现完全一致的包字节（仅公开二进制下载地址不予准入）。
2. 许可证全文、SPDX 表达式与版权声明匹配实际代码，至少提供一套覆盖该插件且符合 OSI 开源定义的授权（如 MIT）。
3. 组合许可与自定义 `LicenseRef` 已逐项审阅，依赖及复用代码的再分发、署名与源码义务均可满足，并在审核理由中记录结论。

## 工具与仓库维护

### 独立治理工具与技术依赖

- `tools/governance/src/main/java/` 维护社区准入、人工裁决、换钥、所有权转移、状态处置、紧急声明、发布记录生成及社区扫描实现，版本由 `tools/governance/version.json` 独立管理。
- `tools/foundation-lock.json` 固定主仓库共享合同、签名、包解析和构建模型的源码 commit / SHA-256，以及 Maven Central 依赖的长度与 SHA-256（无需下载完整 SDK ZIP 或克隆主仓库）。
- 本地构建与测试命令（需 Node.js 24+、JDK 17+ 与已登录的 GitHub CLI）：

```bash
# 构建独立治理工具（输出目录必须不存在，依赖缓存并复验于 target/foundation/）
node scripts/community-tools.mjs target/community-tools

# 运行 Java 治理规则测试与社区流程测试
node scripts/test-governance.mjs
npm test
```

修改向导或治理源码后，执行 `node scripts/submission-manifest.mjs --write` 更新摘要并用 `node scripts/submission-manifest.mjs` 校验闭包；修改协议校验器 `tools/submission-channel.cjs` 后，执行 `node scripts/submission-channel.mjs embed` 同步嵌入 `tools/submit.ps1` 并用 `check` 校验一致。

### 签发投稿工具渠道清单

工具修改经维护 PR 合入 `master` 后，签发新的 90 天有效期渠道清单（日常到期前也需重新签发）：

1. 在 `master` 运行 **Sign submission tool channel**，填写已合入主线的工具完整 commit SHA。
2. 等待入口测试通过并批准 `release` Environment（签发器仅接受主线祖先，核对清单与字节摘要，不执行投稿代码）。
3. 下载运行产物 `submission-tool-channel`，将 `submission-channel.json` 原样放入 `tools/`（切勿格式化或手改），通过维护 PR 合入 `master`。

### 仓库保护与受管标签

```bash
# 预览、核对与应用仓库分支保护 / Ruleset（核对仓库 ID 1347624983 与所有者身份）
npm run repository:plan
npm run repository:check
node scripts/configure-repository.mjs --apply

# 首次初始化受保护的 emergency-state 分支（仅当该分支尚不存在时）
node scripts/configure-repository.mjs --initialize-emergency

# 预览与应用受管标签目录（保留未列入目录的自定义标签）
npm run labels:plan
npm run labels:apply
```

仓库开启 **Automatically delete head branches** 与 **Allow GitHub Actions to create and approve pull requests**。`type:*` 操作标签只追加不自动移除；`state:*` 状态标签由通知投影更新（`state:closed`、`state:merged`、`state:awaiting-apply`、`state:completed`、`state:apply-failed`），标签与评论仅作展示，不授予准入权限。

## 检查、裁决表单与候选归档

主线 PR 要求四项绑定 `sywyar-pixivdownloader-gate` App 的必需检查：`community/validation`、`community/risk-review`、`community/human-review`、`community/admission`（普通 CI 同名检查不授予准入）。

### 审核裁决表单（**Community review decision**）

在 `master` 运行表单，填写 PR 编号、完整 head SHA 与理由：

| 裁决类型 | 用途与约束 |
| --- | --- |
| `SELF_REVIEW_APPROVED` | 授权维护者本人投稿时的显式自审（作者与审核者数字账号 ID 必须相同，不可覆盖有效拒绝，Draft PR 不可用） |
| `FALSE_POSITIVE` | 豁免指定 finding ID，必须绑定实际扫描 `runId` 与 `attempt`（不能代替人工审核） |
| `MANUAL_SCAN_ACCEPTED` | 确认未完成扫描已由人工补充复核，绑定扫描 `runId` 与 `attempt`（不豁免已知发现） |
| `REVOKE_DECISION` | 按目标裁决的 SHA-256 追加撤销记录（保留原证据） |

作者更换 PR head 后必须重新审核，新扫描不继承旧 head 的误报或补扫裁决。需要使用当前主线工具重跑静态检查与隔离重建时，在 `master` 运行 **Submission static check** 并填入 PR 编号。

### 候选归档与自动清理

- **候选复用**：每个申请按（发布者数字账号、账号类型、发布者 ID、插件 ID、版本）复用唯一待审核 Draft Release，保存包、源码与 `review-evidence.zip` 并生成 GitHub OIDC attestation。更新版本扫描若需对比已撤销并迁入技术归档的旧包，由受保护的 **Prepare reviewed baseline** 作业读取并通过 1 天期 artifact 传给只读构建作业。
- **自动与定时清理（Community candidate cleanup）**：申请 PR 未合并关闭时自动清理仍归属该申请的候选 Draft，并每日 04:23 UTC 扫描残留（已重开、已被新申请复用或已公开的 Release 保留）。历史 `operation/` 技术归档须先经 `node scripts/migrate-receipts.mjs` 迁入 Git 并满 90 天无引用后才可清理。

## Environment 与凭据

| Environment | 分支与审批 | 凭据与用途 |
| --- | --- | --- |
| `community-gate` | 仅 `master` | `GATE_APP_PRIVATE_KEY`：换取本仓库短期 `checks:write` token 签发准入检查 |
| `community-status` | 仅 `master`，无人工审批，禁管理员绕过 | 社区插件签名私钥 Secret `COMMUNITY_RELEASE_PRIVATE_KEY_BASE64` 与变量（`COMMUNITY_RELEASE_KEY_ID`、`COMMUNITY_RELEASE_PUBLIC_KEY_BASE64`）、维护者专用无口令 Ed25519 SSH 私钥（`COMMUNITY_REVIEW_BRANCH_SSH_KEY`，最多 16 KiB，用于向开启维护者编辑的 fork 分支快进追加生成提交）、所有者细粒度合并 PAT（`COMMUNITY_REVIEW_BRANCH_TOKEN`，仅授予本仓库 `Contents: Read and write` 与 `Metadata: Read-only`）及 Gate App 私钥 |
| `release` | 仅 `master`，要求人工批准，禁管理员跳过 | `COMMUNITY_TOOL_CHANNEL_PRIVATE_KEY_BASE64`（用于签发工具渠道清单）；同时作为人工运行 **Complete community review** 时的审批门禁 |

社区签名公钥不得与主程序、官方插件或 FFmpeg 信任根混用；切勿将任何私钥或 token 写入 Git、评论或公开 artifact。

## 完成审核与发布

### 1. 自动执行路径（**Apply authorized community request**）

满足以下任一授权条件且静态检查、候选归档就绪时，工作流自动在原 PR 追加生成结果、重签发四项 App 检查并以精确 head 执行 Merge commit，合并后产生的 `master` push 自动触发 **Publish merged community state** 发布或更新 Release：

- **普通版本投稿**：维护者对当前完整 head 提交原生 GitHub `Approve`（或维护者本人提交 `SELF_REVIEW_APPROVED` 裁决），且扫描与归档全部通过。
- **个人所有者签名的管理操作**：当前个人所有者使用活动私钥签署的 `YANK`、`UNYANK`、`REVOKE`；提供新旧双密钥签名证明的个人 `ROUTINE_ROTATION`；不同个人账号之间由接收方签名发起、原所有者在原生 `Approve` Review 中附带活动私钥签名证明的普通所有权转移（向导提交英文 Review 后会追加带专用标记的评论，通过 `Community review event` 唤醒默认分支处理）。

有效的原生 `Request changes` 会阻断自动处理，签名证明和误报裁决不能代替所需的人工审核。

### 2. 特殊授权与人工重试（**Complete community review**）

账号或密钥恢复、组织代表权、缺少密钥证明、涉及社区独立限制的 `UNYANK` 以及自动流程失败后的人工重试，使用手动工作流：

1. 确认请求 PR 的技术检查、候选归档及针对当前完整 head 的有效审核已完成。
2. 在 `master` 运行 **Complete community review**，填写 `prNumber`、`expectedHeadSha` 与审核理由（恢复操作勾选 `recoveryApproved`，组织代表填写核实后的 `organizationId:personId`）。
3. 批准 `release` Environment，由后续 `community-status` 作业串行生成清单与签名、追加提交、核验四项 App 检查并合并 PR。
4. 若合并后 Release 收尾失败，可在 `master` 手动运行 **Publish merged community state** 恢复（`REVOKED` 版本会先归档到 `archive/revoked-packages` Draft 并核对字节，再移除正式 Release 中的公开安装包附件，保留版本说明与历史签名）。

### 3. 紧急密钥泄露声明与撤销清单续签

- **紧急密钥泄露声明（`Community emergency`）**：向导将请求提交至受保护的只追加数据分支 `emergency-state`（记录于 `requests/` 与 `key-blocks/<fingerprint>.json`）。核对个人本人或组织管理员原生身份并通过 `community/emergency` App 检查后自动合并，立即拒绝被封禁公钥的新操作并重算受影响的开放 PR（封禁不可撤回、无到期时间）。
- **撤销清单自动续签（`Renew community revocations`）**：每日 04:23 UTC 检查主线；当 `revocations.json` 剩余有效期不超过 7 天时，在 `chore/community/revocations-renewal` 自动创建续签 PR，验证业务内容与原审核证据未变后以 `POLICY_RENEWAL` 自动签发 30 天新有效期、合并并发布（无需逐次人工 Approve，但维护者 `Request changes` 仍会阻断）。
