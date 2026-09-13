# 贡献说明

版本投稿通过静态检查、隔离重建、风险复核与当前 head 的人工审核后取得准入。仓库所有者从本仓库分支提交工具、规则和文档维护 PR。正式签名发布及换钥、状态、转移执行器尚未接通；合并不表示公开发布。普通投稿者的权限边界是 fork PR，不授予本仓库 Write、Maintain 或 Admin 权限。投稿与工具维护须分开提交，不能在同一 PR 中修改投稿数据及其检查器。

每次投稿固定源码 commit、版本和包摘要。发布者换钥、YANK、UNYANK、REVOKE 和所有权转移使用各自的请求路径，不能夹带在普通版本更新中。已发布记录保留历史字节。

原生 Approve 用于当前 head 的人工审核，Request changes 会阻断准入。授权维护者本人投稿时使用默认分支的显式自审入口；自审如实记录同一作者与审核者，仍不能覆盖其他有效拒绝。标签和评论只展示状态，不授予合并或发布权限。

## 维护者

维护工作通过独立 PR 进行。社区 Schema、签名和审核语义来自固定 SDK 工具与合同资源，不能在分发副本中修改。

投稿者统一使用 [PowerShell 向导](README.md#投稿与版本管理)，准备最终包后选择版本投稿或管理操作。向导只在完整预览得到确认且当前事实复核成功后创建 fork PR；原生身份与静态检查仍由社区端独立取得和计算。

修改向导运行文件后执行 `node scripts/submission-manifest.mjs --write`，再用 `node scripts/submission-manifest.mjs` 校验闭包。先提交运行文件和 `tools/submission-files.json`，再在单独提交中将 `tools/submit.ps1` 的 `RuntimeCommit` 固定到前一提交的完整 SHA，并将 `ManifestSha256` 设为该提交中清单原始字节的 SHA-256。入口本身不进入清单，避免循环引用；发布入口前须确保固定提交及其文件已能从公共仓库读取。不要将固定值改为分支名、移动标签或未经摘要验证的下载地址。

`npm run repository:plan` 输出仓库保护的目标设置。`npm run repository:check` 回读 GitHub 当前设置。`node scripts/configure-repository.mjs --apply` 只在核对数字仓库身份、当前账号及公开状态后应用配置。它不创建仓库、不改变可见性、不上传 Secret、不批准 Environment，也不合并 PR。

`npm run labels:plan` 预览受管标签差异；`npm run labels:apply` 应用名称、颜色和说明。未列入目录的标签保留。

## 检查与表单

四个必需检查为 `community/validation`、`community/risk-review`、`community/human-review` 和 `community/admission`，均绑定 `sywyar-pixivdownloader-gate` App。维护操作经身份与路径核对后明确判定插件扫描不适用。普通 CI 的同名检查不能授予准入权。

作者本人使用默认分支的 **Community review decision** 表单：填写 PR 编号、完整 head SHA、`SELF_REVIEW_APPROVED`、审核理由，并勾选自审确认。审核者与作者的数字账号 ID 必须相同且具有当前授权。Draft PR 不能自审或准入。

`FALSE_POSITIVE` 只豁免列出的 finding ID；填写实际扫描 run ID、attempt 和理由。`MANUAL_SCAN_ACCEPTED` 只确认当前未完成扫描已经人工补充复核，同样绑定扫描 run/attempt，不豁免已知发现。两者都不能代替原生 Review 或自审。组织投稿须核对申请者的代表权，静态账号存在性检查不证明代表权。

`REVOKE_DECISION` 追加撤销记录，填写目标裁决的 SHA-256，保留原证据。每次运行摘要展示裁决摘要，原始 JSON 保存在同一次运行的不可变 artifact 中。同一表单重跑保留原决定身份、对象和时间；原 artifact 缺失时须重新提交表单。新 head 须重新审核，新扫描不能继承旧扫描的误报或补扫裁决。

检查详情与 PR 上的一条机器人评论显示当前摘要；完整源码、依赖、许可证、SBOM、扫描差异与重建证据保存在待审核 Draft 的 `review-evidence.zip`。GitHub artifact attestation 只证明受保护归档流程保存过这些字节，不代表人工批准。不能手动改写候选资产或将待审核 Draft 公开。

需要使用当前受保护工具重新核对时，在默认分支运行 **Submission static check** 并填写 PR 编号。构建输入相同时复用已认证 Draft 的包，规则变化只重扫；同一 head、输入和完整扫描均未变化时直接使用已有归档。旧 run 的 rerun 仍使用原工作流来源，不能代替当前代码的重算。首次归档中断可重跑原归档流程，逐项补齐缺失资产；已有资产摘要冲突或归档证明缺失时保持阻断，不能覆盖或伪造证明。SDK 工具必须包含扫描器且符合固定锁，缺少时失败。

扫描身份同时绑定 SDK 工具包、社区扫描适配器和证据生成代码的原始摘要。任何一项变化都会使旧扫描报告失效；构建输入未变时复用原包重新扫描，准入检查在取得当前扫描证据前保持阻断。

换 head 不会清除原生 Request changes。撤销 review 必须能从原生事件取得操作者和理由。候选 PR 中的代码不会被特权检查或裁决入口执行；入口读取受保护默认分支的固定版本，再核对原生 run、attempt、当前权限和证据字节。签发前后均重读当前事实；GitHub 多次 API 写入并非原子操作，失败时会尝试撤销本次检查。

`tools/sdk-lock.json` 固定 SDK 归档摘要、来源 commit 和元数据摘要。工具 JAR 与 `schemas/community/v1/` 是同一 SDK 的原始分发字节。合同、验签和审核归约在主仓库维护，不能修改分发副本来绕过验证。

`tools/signing-tool.json` 单独固定发布者签名 CLI 的来源 commit、JAR 大小和 SHA-256。它提供密钥初始化、公钥导出和操作请求签名；固定 SDK 与密码学验证保持原样。私钥不能进入投稿文件，不能保存到源码仓库、临时目录、PR 或 artifact。

操作审计固定放在 `audits/<requestId>.json`，只能由受保护操作流程追加。状态读取必须核对请求、决定及前后状态的原始引用；重复请求返回原记录，不改写历史。恢复转移的证据使用 `ownership-transfer-evidence/<pluginId>/<sha256>.bin`，摘要基于原始字节，不能在已有请求中替换。

## Environment 与凭据

| Environment | 限制与凭据 |
|---|---|
| `community-gate` | 仅 `master` 分支；保存现有 Gate App 的 `GATE_APP_PRIVATE_KEY`。官方 App action 只申请本社区仓库的短期 `checks:write` token，并在 job 结束撤销 |
| `release` | 仅 `master` 分支；要求人工批准，允许同一维护者批准自己发起的运行，禁止管理员跳过批准 |

Gate App 必须安装并获准访问本社区仓库。不要把 App 私钥或社区签名私钥写入 Git、评论或 artifact。社区签名私钥只允许在 `release` 的签名步骤使用；当前仓库没有签名入口。

保护配置将所有者的 PR-only bypass 限于更新限制；另一 Ruleset 的四个必需检查、禁止删除和 force push 规则没有 bypass。合并方式为 Merge commit。受保护结果采用机器人结果 PR、所有者合并的模式，配置不授予自动发布 bypass。
