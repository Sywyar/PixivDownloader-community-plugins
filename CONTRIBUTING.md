# 贡献说明

版本投稿通过静态检查、隔离重建、风险复核与人工审核后，由维护者手动完成审核。工作流将清单和签名追加到原投稿 PR；全部准入检查通过并合并后，自动发布已核验的社区候选。仓库所有者从本仓库分支提交工具、规则和文档维护 PR。普通投稿者通过自己的 fork 投稿，不授予本仓库 Write、Maintain 或 Admin 权限；社区所有者使用本仓库内的投稿分支。投稿与工具维护须分开提交，不能在同一 PR 中修改投稿数据及其检查器。

每次投稿固定源码 commit、版本和包摘要。发布者换钥、YANK、UNYANK、REVOKE 和所有权转移使用各自的请求路径，不能夹带在普通版本更新中。已发布记录保留历史字节。

原生 Approve 用于当前 head 的人工审核，Request changes 会阻断准入。授权维护者本人投稿时使用默认分支的显式自审入口；自审如实记录同一作者与审核者，仍不能覆盖其他有效拒绝。标签和评论只展示状态，不授予合并或发布权限。

## 维护者

维护工作通过独立 PR 进行。社区 Schema、签名和审核语义来自固定 SDK 工具与合同资源，不能在分发副本中修改。

投稿者按 [PowerShell 向导说明](README.md#投稿与版本管理) 推送源码，等待候选 CI 通过后选择版本投稿；管理操作使用同一入口。向导只在完整预览得到确认且当前事实复核成功后公开源码候选并创建投稿 PR；原生身份与静态检查仍由社区端独立取得和计算。

修改向导运行文件后执行 `node scripts/submission-manifest.mjs --write`，再用 `node scripts/submission-manifest.mjs` 校验闭包。运行文件和清单经测试及 PR 合并后，按下节签发新的工具版本清单。日常向导更新只改签名清单，投稿命令保持不变。

### 更新投稿工具

1. 在默认分支运行 **Sign submission tool channel**，填写已合并的工具源码完整 SHA。
2. 等待入口测试通过并批准 `release` Environment。签发器只接受主线祖先，逐文件核对该提交的清单、大小和摘要，不执行所选提交中的工具。
3. 下载运行产物 `submission-tool-channel`，将其中的 `submission-channel.json` 原样放入 `tools/`，通过维护 PR 合并。不要格式化或手改签名文件；运行产物保留七天，workflow 不直接推送默认分支。

版本清单有效期为九十天，到期前需要再次签发，即使工具源码没有变化。每次签发基于最新 `origin/master` 的清单递增序号；多个尚未合并的签发结果可能使用同一序号，只合并其中一个，其余重新签发。签名、有效期、历史序号或缓存核验失败时，入口停止，不回退到旧工具。首次使用或删除本地状态后，历史序号保护从当前有效清单重新开始。

`tools/submission-channel.cjs` 是协议校验器的唯一源码，`node scripts/submission-channel.mjs embed` 将其嵌入 PowerShell，`check` 验证二者一致。投稿命令读取 `master/tools/submit.ps1`，启动器及其内置公钥和校验代码以受保护的 `master` 为来源。修改启动器须通过维护 PR 和入口回归，并验证与已发布签名清单的兼容性；用户下次执行同一命令即可取得更新。签名清单始终从 `master/tools/submission-channel.json` 读取，工具文件仅从验签通过的完整 commit 下载。

`npm run repository:plan` 输出仓库保护的目标设置。`npm run repository:check` 回读 GitHub 当前设置。`node scripts/configure-repository.mjs --apply` 只在核对数字仓库身份、当前账号及公开状态后应用配置。它不创建仓库、不改变可见性、不上传 Secret、不批准 Environment，也不合并 PR。

`npm run labels:plan` 预览受管标签差异；`npm run labels:apply` 应用名称、颜色和说明。未列入目录的标签保留。

## 检查与表单

四个必需检查为 `community/validation`、`community/risk-review`、`community/human-review` 和 `community/admission`，均绑定 `sywyar-pixivdownloader-gate` App。维护操作经身份与路径核对后明确判定插件扫描不适用。普通 CI 的同名检查不能授予准入权。

作者本人使用默认分支的 **Community review decision** 表单：填写 PR 编号、完整 head SHA、`SELF_REVIEW_APPROVED`、审核理由，并勾选自审确认。审核者与作者的数字账号 ID 必须相同且具有当前授权。Draft PR 不能自审或准入。

`FALSE_POSITIVE` 只豁免列出的 finding ID；填写实际扫描 run ID、attempt 和理由。`MANUAL_SCAN_ACCEPTED` 只确认当前未完成扫描已经人工补充复核，同样绑定扫描 run/attempt，不豁免已知发现。两者都不能代替原生 Review 或自审。组织投稿须核对申请者的代表权，静态账号存在性检查不证明代表权。

`REVOKE_DECISION` 追加撤销记录，填写目标裁决的 SHA-256，保留原证据。每次运行摘要展示裁决摘要，原始 JSON 保存在同一次运行的不可变 artifact 中。同一表单重跑保留原决定身份、对象和时间；原 artifact 缺失时须重新提交表单。作者修改 head 后须重新审核，新扫描不能继承旧扫描的误报或补扫裁决。完成审核工作流追加的提交按下节规则复核直接父提交；撤销该父提交的裁决时，表单仍填写原审核 head，执行器同时核对当前生成提交未变化。

检查详情与 PR 上的一条机器人评论显示当前摘要；完整源码、依赖、许可证、SBOM、扫描差异与重建证据保存在待审核 Draft 的 `review-evidence.zip`。GitHub artifact attestation 只证明受保护归档流程保存过这些字节，不代表人工批准。不能手动改写候选资产或将待审核 Draft 公开。

PR 关闭后，Gate 更新终态标签和摘要，保留已有准入检查。未合并关闭显示 `state:closed`；维护 PR 合并后显示 `state:merged`。投稿和管理请求合并后，等待执行时显示 `state:awaiting-apply`，结果及 Release 回读完成后显示 `state:completed`，回读失败时显示 `state:apply-failed`。重新打开的 PR 按当前 head、工作流来源和审核证据重新计算准入。

需要使用当前受保护工具重新核对时，在默认分支运行 **Submission static check** 并填写 PR 编号。构建输入相同时复用已认证 Draft 的包，规则变化只重扫；同一 head、输入和完整扫描均未变化时直接使用已有归档。旧 run 的 rerun 仍使用原工作流来源，不能代替当前代码的重算。首次归档中断可重跑原归档流程，逐项补齐缺失资产；已有资产摘要冲突或归档证明缺失时保持阻断，不能覆盖或伪造证明。SDK 工具必须包含扫描器且符合固定锁，缺少时失败。

扫描身份同时绑定 SDK 工具包、社区扫描适配器和证据生成代码的原始摘要。任何一项变化都会使旧扫描报告失效；构建输入未变时复用原包重新扫描，准入检查在取得当前扫描证据前保持阻断。

换 head 不会清除原生 Request changes。撤销 review 必须能从原生事件取得操作者和理由。候选 PR 中的代码不会被特权检查或裁决入口执行；入口读取受保护默认分支的固定版本，再核对原生 run、attempt、当前权限和证据字节。签发前后均重读当前事实；GitHub 多次 API 写入并非原子操作，失败时会尝试撤销本次检查。

`tools/sdk-lock.json` 固定 SDK 归档摘要、来源 commit 和元数据摘要。工具 JAR 与 `schemas/community/v1/` 是同一 SDK 的原始分发字节。合同、验签和审核归约在主仓库维护，不能修改分发副本来绕过验证。

`tools/signing-tool.json` 单独固定发布者签名 CLI 的来源 commit、JAR 大小和 SHA-256。它提供密钥初始化、密码加密、公钥导出和操作请求签名，向导也可读取已有明文私钥。项目档案只保存密钥路径和身份，密码仅留在当前签名会话。私钥不能进入投稿文件，不能保存到源码仓库、临时目录、PR 或 artifact。

操作审计固定放在 `audits/<requestId>.json`，只能由受保护操作流程追加。状态读取必须核对请求、决定及前后状态的原始引用；重复请求返回原记录，不改写历史。恢复转移的证据使用 `ownership-transfer-evidence/<pluginId>/<sha256>.bin`，摘要基于原始字节，不能在已有请求中替换。

## Environment 与凭据

| Environment | 限制与凭据 |
|---|---|
| `community-gate` | 仅 `master` 分支；保存现有 Gate App 的 `GATE_APP_PRIVATE_KEY`。官方 App action 只申请本社区仓库的短期 `checks:write` token，并在 job 结束撤销 |
| `release` | 仅 `master` 分支；要求人工批准，允许同一维护者批准自己发起的运行，禁止管理员跳过批准。工具清单私钥 `COMMUNITY_TOOL_CHANNEL_PRIVATE_KEY_BASE64` 与插件签名私钥 `COMMUNITY_RELEASE_PRIVATE_KEY_BASE64` 分开保存，各自仅传给对应签名步骤 |

Gate App 必须安装并获准访问本社区仓库。不要把 App 私钥或签名私钥写入 Git、评论或 artifact。工具清单公钥固定在启动器中，不用于插件包签名。两类私钥都保存 PKCS#8 PEM 文件的 Base64 编码，密钥默认不设置到期时间。

插件签名还需在 `release` 配置 `COMMUNITY_RELEASE_KEY_ID` 和 `COMMUNITY_RELEASE_PUBLIC_KEY_BASE64` 变量，后者为 Ed25519 SPKI DER 的 Base64。社区密钥不能使用官方应用、插件或 FFmpeg 根公钥；已发布社区根不能通过改变量直接替换。

同仓库投稿分支使用工作流的仓库 token。fork 投稿须开启 **Allow edits from maintainers**，并由维护者在 `release` 配置确实能写入该 fork 分支的 `COMMUNITY_REVIEW_BRANCH_TOKEN`；复选框本身不会赋予 `GITHUB_TOKEN` 跨仓库写权限。此凭据只传给追加原分支提交的步骤，不用于签名。缺少编辑许可或凭据时，工作流给出提示并保留待审核状态。

## 完成审核与发布

1. 等待请求 PR 的技术检查和候选归档完成，复核原包、源码及审核证据。原生 Review 或显式自审必须针对当前完整 head SHA。
2. 在 `master` 手动运行 **Complete community review**，填写 `prNumber`、`expectedHeadSha` 和审核理由。恢复操作须勾选 `recoveryApproved`；组织代表权经人工核对后填写 `organizationId:personId`，多项以逗号分隔。
3. 批准 `release` Environment。执行器再次核对事实，调用固定 SDK 生成清单、签名和审计，在原 PR 分支追加一个提交。此时正式 Release 仍未公开。
4. 等待四项 App 检查通过，再使用 Merge commit 合并原 PR。Gate 核对生成工作流的归档证明、唯一直接父提交、完整树差异及每份生成文件的原始字节，并重新读取人工拒绝、撤销和当前权限；只核对父 SHA 或复制旧成功检查均不足以放行。
5. **Publish merged community state** 响应 `master` 合并，验证真实 merge 的父提交、准入检查及候选签名，再公开原社区候选并匿名下载核对。它还更新已发布版本的状态和当前维护者，保留原包、签名和历史作者。

转移提案与双方批准分别保存在各自请求 PR。不同账号的批准必须来自不同自然人和 PR；同一账号下的发布者转移允许同一 PR 包含两个角色。尚缺另一方批准时，只合并当前已审核记录，所有权不变；最后一份有效批准完成审核后才生成转移结果。恢复转移仍要求接收方批准、请求引用的恢复证据及明确的 Environment 恢复批准。

正式 tag 为 `<原发布者>/<pluginId>-v<version>`，安装包名称也包含原发布者。`operation/<requestId>/<runId>-<attempt>` 技术 Draft 保存精确生成结果与 GitHub 证明，不自动删除。整个审核等待和正式发布过程复用已验证候选，不重新构建。

追加提交前中断，可针对未变化的原 head 再次完成审核；若生成提交已经追加，重复运行只验证已有结果。作者、源码、包、base、规则或生成字节变化后，旧结果不再放行。作者需先移除未合并的生成改动，使 PR 只保留请求数据，再重新审核。已合并请求的 Release 收尾失败，可在 `master` 手动运行 **Publish merged community state**；同名异字节资产拒绝覆盖，重跑不执行旧状态写入。

YANK、UNYANK、REVOKE 只对已发布版本执行。UNYANK 只解除请求引用的管理者下架；社区独立限制继续保留。REVOKE 没有恢复操作。例行换钥保留历史 key；泄露处置同时为旧 key 签发过的历史包生成独立撤销限制。

未合并准备结果的有效期为三十天，过期后不能取得准入。撤销清单的 `nextUpdate` 与工具渠道九十天有效期分别校验；密钥本身没有因此到期。合并后 Release 收尾不会续签撤销清单。

### 撤销清单续签

**Renew community revocations** 每周一 04:23 UTC 检查主线，也支持手动运行。没有已发布整代或有效期还超过七天时不写入；临近到期时，由 GitHub Actions 机器人在 `chore/community/revocations-renewal` 创建维护 PR，固定当前整代和撤销清单摘要。已有开放续签 PR 时返回原链接，不覆盖其中的修改；同一请求被关闭后不会自动重开，维护者可以重新打开原 PR。

维护者核对请求后，在 GitHub 提交 **Approve** Review，再运行 **Complete community review** 并批准 `release` Environment。签发器把新的三十天有效期、递增序号和签名追加到续签 PR，保留全部限制记录、历史包及归属；检查通过后使用 Merge commit 合并。机器人不能代替维护者审核，也不使用作者自审表单。创建 PR 本身尚未延长有效期。

仓库需要开启 Actions 的 **Allow GitHub Actions to create and approve pull requests**，默认 token 权限仍保持只读，只有续签 job 显式申请写入。准入只接受已授权自然人的审核，机器人批准不会放行。为避免 job token 抑制事件，续签入口显式启动该 PR 的静态检查与 Gate；它不会启动签名、自动合并或关闭普通申请。暂停此 workflow 会停止自动创建续签请求，已有清单仍按原有效期使用。

这类独立 PR 只负责无申请时的清单续签；插件发布、换钥、状态处置和转移继续在各自原申请 PR 内完成。

master 代码检查不读取开放 PR 列表。社区 Gate 只检查本次事件或显式指定的 PR；投稿向导仍查询开放请求进行查重和取消操作。保护配置保持四项必需检查、禁止删除和 force push 的约束，不授予工作流合并 bypass。
