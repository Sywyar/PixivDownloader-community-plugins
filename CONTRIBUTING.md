# 贡献说明

版本投稿通过静态检查、隔离重建、风险复核与当前 head 的人工审核后取得合并准入。合并请求后，维护者执行发布，再审核并合并结果 PR。仓库所有者从本仓库分支提交工具、规则和文档维护 PR。普通投稿者通过自己的 fork 投稿，不授予本仓库 Write、Maintain 或 Admin 权限；社区所有者使用本仓库内的投稿分支。投稿与工具维护须分开提交，不能在同一 PR 中修改投稿数据及其检查器。

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

`REVOKE_DECISION` 追加撤销记录，填写目标裁决的 SHA-256，保留原证据。每次运行摘要展示裁决摘要，原始 JSON 保存在同一次运行的不可变 artifact 中。同一表单重跑保留原决定身份、对象和时间；原 artifact 缺失时须重新提交表单。新 head 须重新审核，新扫描不能继承旧扫描的误报或补扫裁决。

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

插件签名还需在 `release` 配置 `COMMUNITY_RELEASE_KEY_ID` 和 `COMMUNITY_RELEASE_PUBLIC_KEY_BASE64` 变量，后者为 Ed25519 SPKI DER 的 Base64。社区密钥不能使用官方应用、插件或 FFmpeg 根公钥；已发布社区根也不能通过改变量直接替换。`COMMUNITY_PUBLICATION_TOKEN` 是社区所有者的令牌，只传给结果归档、Release 提升和结果 PR 写入步骤，需能读仓库审核与 Actions 事实并写本社区仓库 Contents、Pull requests。使用独立令牌创建的结果 PR 会触发原生检查；签名步骤只有仓库读取令牌。

## 执行审核结果

1. 确认请求 PR 已通过四项 App 检查和当前 head 的人工审核，再使用 Merge commit 合并。转移时，接收方创建含新密钥证明的 proposal，双方分别提交角色 approval；不同账号的批准须来自各自的 PR。同一账号下的发布者转移可以在同一 PR 批准两个角色。
2. 在 `master` 运行 **Apply reviewed community operation**，选择 `action=apply`，填写已合并请求的 `prNumber` 和原审核的完整 `expectedHeadSha`。需要恢复时显式勾选 `recoveryApproved`；组织代表权须经人工核对后，填写 `organizationId:personId`，多项用逗号分隔。单纯查询到组织存在不能证明代表权。
3. 预检通过后审阅并批准 `release` Environment。执行器复核当前原生审核、主线、绑定及密钥，调用固定 SDK 生成结果。版本发布直接使用已归档并核对的原包，等待审核和正式签名不再构建。
4. 检查生成的 Draft 结果 PR，转为 Ready，并完成当前 head 的人工审核和四项 App 检查后合并。结果 PR 逐字节匹配受保护签发记录；投稿者不能通过仿造生成路径取得写权限。主线一次提交应用完整目录、撤销快照与审计。
5. 等待同一 workflow 的自动收尾。它核对原包与历史资产，更新 Release 的状态及当前维护者，回写请求状态；版本撤销和所有权转移不会覆盖原包、原签名或历史作者。

正式版本的 tag 为 `<原发布者>/<pluginId>-v<version>`，安装包名称也包含原发布者。执行器在结果 PR 创建前，将已核验的社区候选提升为正式 Release，并匿名下载核对公开包；目录准入仍以结果 PR 合并为准。`operation/<requestId>/<runId>-<attempt>` Draft 保留精确结果清单及 GitHub 归档证明，不自动过期删除。

若上传、Release 提升或结果 PR 创建中断，重新运行相同请求和 head：执行器先读取已证明的结果，补齐缺失步骤，同名异字节资产拒绝覆盖。关闭的结果 PR 会使用新分支重新创建。其它请求推进主线时，只在当前发布者、绑定、源码前序及工具仍符合原证明时重用已签发版本，重算当前目录。已生效请求只回读结果并重试 Release 收尾，不再执行旧写入。工具、身份或原始字节变化时停止，并按具体错误重新审核；不得删除审计或改资产绕过检查。

YANK、UNYANK、REVOKE 只对已发布版本执行。UNYANK 只解除请求引用的管理者下架，社区独立限制继续保留；REVOKE 没有恢复操作。例行换钥将旧 key 留作历史，泄露处置还为使用该旧 key 的历史包生成独立撤销限制。恢复转移必须有接收方批准、可取回的恢复证据及明确的 Environment 恢复批准。

撤销清单每次签发后有效三十天。即使没有新投稿，也须在 `nextUpdate` 前运行同一 workflow 的 `action=refresh`，其余请求输入留空，再批准 Environment、审核并合并结果 PR。续签递增整代与撤销序号，保留全部限制、原包和历史记录；过期不能用删除撤销条目解决。未合并结果过期时，检查会阻断；关闭旧结果 PR，重新执行原请求，复用已签发原包并生成当前整代。工具渠道的九十天有效期独立维护。

保护配置将所有者的 PR-only bypass 限于更新限制；另一 Ruleset 的四个必需检查、禁止删除和 force push 规则没有 bypass。合并方式为 Merge commit。受保护执行器创建结果 PR，由所有者审核合并，配置不授予自动发布 bypass。
