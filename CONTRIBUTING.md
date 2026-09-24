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

目标配置开启 GitHub 的 **Automatically delete head branches**，在 PR 合并后清理本仓库的来源分支，包括所有者的投稿分支、工具维护分支及紧急请求分支。`master` 和 `emergency-state` 的禁止删除规则保持有效。投稿者 fork 的分支由其仓库设置和权限控制；向导关闭未合并请求时，仍须另行确认删除。

自动合并与审核提交的标题均标明请求对象：版本操作显示 `发布者 / 插件-v版本`，密钥轮换显示 `发布者 publisherId`，所有权转移显示 `原发布者 / 插件 → 新发布者`。发布结果与通知分别核验。排队期间主线仅追加数据时，执行来源须仍为主线祖先且检查器、工作流、工具与合同资源未变；最终结果绑定出队后读取的主线。空通知不会启动作业，通知仍重新核对 PR head 和状态。

`npm run labels:plan` 预览受管标签差异；`npm run labels:apply` 应用名称、颜色和说明。未列入目录的标签保留。

操作标签 `type:*` 只追加，持续标识已识别的请求类型；其中 `type:key-compromise` 标识密钥泄露声明。状态标签单独更新，失败、关闭或完成不会移除操作标签。标签只供展示和检索，不能证明身份、审核通过或操作已生效。标签目录变化时，维护者须应用目录后再使用新增标签。

## 检查与表单

四个必需检查为 `community/validation`、`community/risk-review`、`community/human-review` 和 `community/admission`，均绑定 `sywyar-pixivdownloader-gate` App。维护操作经身份与路径核对后明确判定插件扫描不适用。普通 CI 的同名检查不能授予准入权。

作者本人使用默认分支的 **Community review decision** 表单：填写 PR 编号、完整 head SHA、`SELF_REVIEW_APPROVED`、审核理由，并勾选自审确认。审核者与作者的数字账号 ID 必须相同且具有当前授权。Draft PR 不能自审或准入。

`FALSE_POSITIVE` 只豁免列出的 finding ID；填写实际扫描 run ID、attempt 和理由。`MANUAL_SCAN_ACCEPTED` 只确认当前未完成扫描已经人工补充复核，同样绑定扫描 run/attempt，不豁免已知发现。两者都不能代替原生 Review 或自审。组织投稿须核对申请者的代表权，静态账号存在性检查不证明代表权。

`REVOKE_DECISION` 追加撤销记录，填写目标裁决的 SHA-256，保留原证据。每次运行摘要展示裁决摘要，原始 JSON 保存在同一次运行的不可变 artifact 中。同一表单重跑保留原决定身份、对象和时间；原 artifact 缺失时须重新提交表单。作者修改 head 后须重新审核，新扫描不能继承旧扫描的误报或补扫裁决。完成审核工作流追加的提交以原审核 head 为第一父节点，并按下节规则复核完整父链；撤销原审核 head 的裁决时，表单仍填写该 head，执行器同时核对当前生成提交未变化。

检查详情与 PR 上的状态评论显示当前摘要；中文和英文各有一条请求信息评论，由同一份已验证请求生成并统一更新，展示操作、分类、理由和验签情况。申请者填写的说明保留原文；更新时按语言复用原评论，部分写入失败后再次同步可补齐。完整源码、依赖、许可证、SBOM、扫描差异与重建证据保存在待审核 Draft 的 `review-evidence.zip`。GitHub artifact attestation 只证明受保护归档流程保存过这些字节，不代表人工批准。不能手动改写候选资产或将待审核 Draft 公开。

PR 关闭后，Gate 更新终态标签和摘要，保留已有准入检查。未合并关闭显示 `state:closed`；维护 PR 合并后显示 `state:merged`。投稿和管理请求合并后，等待执行时显示 `state:awaiting-apply`，结果及 Release 回读完成后显示 `state:completed`，回读失败时显示 `state:apply-failed`。重新打开的 PR 按当前 head、工作流来源和审核证据重新计算准入。

需要使用当前受保护工具重新核对时，在默认分支运行 **Submission static check** 并填写 PR 编号。构建作业保持只读；没有 Draft 读取权限时执行隔离重建，不为复用缓存授予写权限。旧 run 的 rerun 仍使用原工作流来源，不能代替当前代码的重算。SDK 工具必须包含扫描器且符合固定锁，缺少时失败。

更新版本需要与上次审核包比较。若旧包已撤销并迁入技术 Draft，独立的 **Prepare reviewed baseline** 作业用受保护主线代码和 Contents write token 读取原包，不运行投稿源码。包通过同一次运行的一天期 artifact 交给只读构建作业，再按已审核记录核对大小和摘要；交接缺失或字节变化会阻断扫描。

社区候选按发布者数字账号、账号类型、发布者 ID、插件 ID 和版本复用一个草稿。提交变化和 CI 重试更新这个草稿；另一个开放请求不能覆盖它。PR、head、源码与包摘要保存在候选清单中，每次替换重新生成证明，旧审核不能自动沿用。工作流先移除旧证明，更新产物后再写入清单和新证明；中断时保持待归档状态，同一次构建可补齐缺失资产。正式发布仍公开同一个 Release，之后禁止覆盖包和历史证据。已有按 PR 命名的草稿继续可读，后续归档可就地复用。

**Community candidate cleanup** 在申请 PR 未合并关闭时清理所属候选，并每日扫描历史残留，也支持手动运行。它与归档和发布共用队列，只执行受保护主线代码，使用仓库内置 token，不依赖投稿者或向导选择。删除前重读 PR、Release 与资产；已重新打开、被新申请复用或已经公开的候选保留。旧 `operation/` 技术归档须不再使用满九十天才清理；已合并回执引用的归档必须先迁入 Git 并重新验签，保留期从迁移提交、请求关闭、运行结束及资产更新中的最晚时间计算。开放请求、未结束运行、缺失证明或读取不完整均不能作为删除依据。结果记录在 Actions 摘要中。源码仓库 Release、正式版本说明及仍被发布记录引用的撤销包归档不在周期清理范围。若 GitHub 停用了长期无活动仓库的定时运行，维护者须重新启用或手动扫描。

自审、Gate 和完成审核预检通过本次运行的 `GITHUB_TOKEN` 读取草稿。这些受保护作业显式申请 `contents: write`，固定执行主线代码，不执行投稿源码，也不需要投稿者提供令牌。草稿可见性以 Release API 的实际响应为准，不用仓库角色字段推断令牌权限。列表请求返回 HTTP 401 或 403 时报告 `CANDIDATE_ARCHIVE_READ_FORBIDDEN`；未找到完整、已验证的候选时保持等待，同时提示检查归档是否完成及令牌能否读取 Draft。空列表不能证明候选不存在，也不会授予准入。

扫描身份同时绑定 SDK 工具包、社区扫描适配器和证据生成代码的原始摘要。任何一项变化都会使旧扫描报告失效；构建输入未变时复用原包重新扫描，准入检查在取得当前扫描证据前保持阻断。

换 head 不会清除原生 Request changes。撤销 review 必须能从原生事件取得操作者和理由。候选 PR 中的代码不会被特权检查或裁决入口执行；入口读取受保护默认分支的固定版本，再核对原生 run、attempt、当前权限和证据字节。签发前后均重读当前事实；GitHub 多次 API 写入并非原子操作，失败时会尝试撤销本次检查。

`tools/sdk-lock.json` 固定 SDK 归档摘要、来源 commit 和元数据摘要。工具 JAR 与 `schemas/community/v1/` 是同一 SDK 的原始分发字节。合同、验签和审核归约在主仓库维护，不能修改分发副本来绕过验证。

`tools/signing-tool.json` 单独固定发布者签名 CLI 的来源 commit、JAR 大小和 SHA-256。它提供密钥初始化、密码加密、公钥导出和操作请求签名，向导也可读取已有明文私钥。密钥路径和身份按发布者共享，并区分当前操作账号；工程表单和进度仍按项目隔离。每次使用按真实公钥指纹和配对验证更新路径，密码仅留在当前签名会话。私钥不能进入投稿文件，不能保存到源码仓库、临时目录、PR 或 artifact。

操作审计固定放在 `audits/<requestId>.json`，只能由受保护操作流程追加。状态读取必须核对请求、决定及前后状态的原始引用；重复请求返回原记录，不改写历史。恢复转移的证据使用 `ownership-transfer-evidence/<pluginId>/<sha256>.bin`，摘要基于原始字节，不能在已有请求中替换。

## Environment 与凭据

| Environment | 限制与凭据 |
|---|---|
| `community-gate` | 仅 `master` 分支；保存现有 Gate App 的 `GATE_APP_PRIVATE_KEY`。官方 App action 只申请本社区仓库的短期 `checks:write` token，并在 job 结束撤销 |
| `community-status` | 仅 `master` 分支，禁止管理员绕过，无人工审批。保存社区插件签名私钥及配套公钥变量、维护者分支令牌和现有 Gate App 私钥。用于签名管理请求、紧急声明，以及已获人工批准请求的生成与合并 |
| `release` | 仅 `master` 分支；要求人工批准，允许同一维护者批准自己发起的运行，禁止管理员跳过批准。工具清单签发使用独立的 `COMMUNITY_TOOL_CHANNEL_PRIVATE_KEY_BASE64`；完成审核通过此环境取得人工批准，插件签名在后续的 `community-status` 作业执行 |

Gate App 必须安装并获准访问本社区仓库。不要把 App 私钥或签名私钥写入 Git、评论或 artifact。工具清单公钥固定在启动器中，不用于插件包签名。两类私钥都保存 PKCS#8 PEM 文件的 Base64 编码，密钥默认不设置到期时间。

插件签名需在 `community-status` 配置 `COMMUNITY_RELEASE_KEY_ID` 和 `COMMUNITY_RELEASE_PUBLIC_KEY_BASE64` 变量，后者为 Ed25519 SPKI DER 的 Base64。人工完成审核仍须先通过 `release` 批准，再进入签名与合并作业。社区密钥不能使用官方应用、插件或 FFmpeg 根公钥；已发布社区根不能通过改变量直接替换。

同仓库投稿分支使用工作流的仓库 token。fork 投稿须开启 **Allow edits from maintainers**，并由维护者在 `community-status` 配置确实能写入该 fork 分支的 `COMMUNITY_REVIEW_BRANCH_TOKEN`；复选框本身不会赋予 `GITHUB_TOKEN` 跨仓库写权限。人工与自动流程均用该令牌以仓库所有者身份合并原 PR；令牌须能读当前用户、写入目标 fork 分支及合并社区 PR。合并前核对所有者数字 ID，仍遵守全部保护规则。此凭据不用于签名。缺少编辑许可或凭据时，工作流给出提示并保留请求。

## 完成审核与发布

### 作者签名的管理操作

**Apply signed owner request** 在静态检查或原生 Review 事件工作流完成后检查相应请求，也支持按 PR 编号和完整 head 手动重试。当前个人管理者活动密钥签署的 YANK、UNYANK、REVOKE 会重新核对当前 binding、发布包和状态。个人 `ROUTINE_ROTATION` 另行读取主线发布者记录，验证新旧密钥对同一请求正文的签名、旧 keyId、发布者记录摘要及原生 PR 作者；历史 keyId 或公钥不能重复使用。不同个人账号之间的普通转移要求接收方签署申请，原所有者以活动密钥签署同一正文，并在该申请的原生 Approve Review 中提供证明。SDK 核验双方身份和签名，最终写入前复核最新 Review、活动密钥及紧急状态。组织代表权、账号或密钥恢复、缺少证明及涉及社区独立限制的 UNYANK 转入下方人工流程。

执行器在原 PR 追加生成结果，并直接调用 Gate 重新签发准入检查。Gate 记录 `SIGNED_OWNER` 授权，保留真实人工审核状态及拒绝；原生检查回读最多等待五秒。四项绑定 App 的检查通过后，执行器重新核对原请求、生成父链和当前事实，以精确 head 请求 Merge commit。受保护规则仍可阻止合并；失败时保留分支和生成归档。合并后显式触发现有 Release 收尾流程，同仓投稿也不依赖机器人提交触发普通事件。

合并前的操作审计记为 `PREPARED`，不伪造合并 SHA；收尾时固定原始审计字节，并核对真实生成提交和 merge 的有序父节点。状态操作复用已发布包，不触发重建，也不改变作者签名或原包。合并后的本仓库分支由 GitHub 按仓库设置自动清理；取消未合并请求时，向导仍须另行确认删除。

### 需要人工审核的请求

1. 等待请求 PR 的技术检查和候选归档完成，复核原包、源码及审核证据。原生 Review 或显式自审必须针对当前完整 head SHA。
2. 在 `master` 手动运行 **Complete community review**，填写 `prNumber`、`expectedHeadSha` 和审核理由。恢复操作须勾选 `recoveryApproved`；组织代表权经人工核对后填写 `organizationId:personId`，多项以逗号分隔。
3. 批准 `release` Environment。批准在队列外等待；随后 `community-status` 作业取得共享队列，读取最新主线，重新核验请求，调用固定 SDK 生成清单、签名和审计，并向原 PR 追加提交。此时正式 Release 仍未公开。
4. 同一作业重新签发并回读四项 App 检查，全部通过后以精确 head 请求 Merge commit。Gate 核对生成工作流证明、有序父链、完整树及每份文件的原始字节，并重读人工拒绝、撤销、当前权限和紧急状态。生成、检查与合并共用一个串行区间，严格的主线同步规则保持开启。
5. **Publish merged community state** 响应 `master` 合并，验证真实 merge 的父提交、准入检查及候选签名，再公开原社区候选并匿名下载核对。它还更新已发布版本的状态和当前维护者。REVOKED 包先按 SHA-256 保存到共享技术 Draft，再核对下载字节，最后移除正式 Release 的安装包附件；版本说明、签名和历史作者保留。归档或回读失败不删除公开包；GitHub 不允许修改的不可变 Release 保持失败，不能报告清理成功。

新转移申请由接收方创建，原所有者在同一 PR 的原生 Review 中确认；不同账号必须由不同自然人确认，同一账号下的发布者转移仍须两个明确角色。缺少确认时保持原 PR 开放，不能先合并申请。普通网页 Approve 不含密钥证明，须完成上述人工流程；组织代表权须单独核实，维护者批准不能代替原所有者确认。向导的拒绝操作提交 `REQUEST_CHANGES` Review，由通知作业复核当前申请、归属和有效 Review 后关闭原 PR；关闭结果以 PR 实际状态为准。恢复转移要求接收方批准、请求引用的恢复证据及明确的 Environment 恢复批准。

向导的同意与拒绝 Review 使用英文正文，请求摘要和可选签名放在隐藏标记中；已提交的明文标记仍可识别。Review 回读确认后，向导追加一条链接到该 Review 的普通 PR 评论。`Community review event` 从默认分支接收带专用标记的评论，再唤醒 Gate 和自动处理流程；它没有仓库写权限，不检出或运行投稿代码。普通评论及机器人状态评论不进入处理。通知评论只用于唤醒，授权仍须重新核对原生 Review、账号、请求和当前 head。发送中断后，向导回读已有 Review 和通知，再补齐未完成的写入。

正式 tag 为 `<原发布者>/<pluginId>-v<version>`，安装包名称也包含原发布者。新审核结果及 GitHub 证明随原申请 PR 存入 Git，不再创建 `operation/` Draft。回执引用结果文件的 Git 对象、大小和 SHA-256，并分别记录工作流源码、应用主线和原审核 head。证明按内容摘要保存，相同字节复用。生成与追加在同一作业中交接；合并后的验证依赖 Git 历史。整个审核和发布过程复用已验证候选，不重新构建。

历史归档迁移在已同步主线的维护分支运行 `node scripts/migrate-receipts.mjs`。工具验证原证明、合并父链和生成文件，只生成待评审的 Git 文件；不改旧回执、签名或远端 Release。历史正文引用现有 Git blob，验证时重建原始字节并核对原 SHA-256。迁移文件与适配器通过维护 PR 合并后，旧 Draft 才有资格进入上述保留期清理。

追加提交前中断，可针对未变化的原 head 重试；已经追加时，填写当前生成 head。若只有主线数据推进或准备结果过期，流程先验证旧回执与完整树，再从原请求和最新主线重新生成。生成提交保留原审核 head 和应用主线为父节点；恢复时还保留上一生成提交，始终快进，不强推。原请求、归属、密钥、规则、父链或生成字节变化仍会阻断。续签请求绑定整代摘要，过期后须重新创建续签请求。已合并请求的 Release 收尾失败，可在 `master` 手动运行 **Publish merged community state**；同名异字节资产拒绝覆盖，重跑不执行旧状态写入。

维护 SDK 时，须先发行包含 `CommunityPr.hasGeneratedParents` 的不可变工具包，再更新本仓库的 SDK 锁与原始分发文件。旧工具会在编译执行适配器时停止，不能在不支持合并父链验证的工具上生成或合并新结果。本地回归可通过测试专用 `COMMUNITY_TEST_SDK_CLASSES` 指定候选 classes；生产入口不接受此覆盖。

YANK、UNYANK、REVOKE 只对已发布版本执行。UNYANK 只解除请求引用的管理者下架；社区独立限制继续保留。REVOKE 没有恢复操作。换钥把旧密钥标记为 RETIRED，保留历史包验证；泄露密钥须先完成紧急声明，不能通过换钥解除封禁。确需撤销历史包时另行提出版本撤销请求。

### 紧急密钥声明

向导把声明提交到受保护的 `emergency-state` 数据分支。`Community emergency` 只执行 `master` 工作流，核对原生 PR 作者与当前登记密钥，为请求追加固定封禁记录；绑定 Gate App 的 `community/emergency` 检查通过后，用普通 Merge commit 合并。个人发布者仅本人可声明；组织发布者要求原生 API 证实作者具有管理员角色，成员身份或无法读取权限均不放行。

请求使用 `requests/<accountId>/<publisherId>/<requestId>.json`，封禁按公钥指纹保存在 `key-blocks/<fingerprint>.json`。分支只追加数据，不承载可执行代码；修改 keyId 不能绕过封禁。已合并声明没有撤回或到期操作。关闭未合并 PR 不生效，关闭其它 PR 不解除既有封禁。

候选验证和人工 Environment 等待在共享队列外完成；最终准入、结果写入、自动合并及紧急生效串行复核。封禁生效前撤回受影响的开放请求检查，随后重新检查这些请求。通知失败时封禁仍已生效，可重跑原紧急工作流恢复通知。已公开版本不变，尚未公开的草稿在公开前再次核验密钥。

部署时先核对 `repository:plan`，对尚不存在的紧急分支运行 `node scripts/configure-repository.mjs --initialize-emergency`，再应用并回读 Ruleset；命令拒绝覆盖同名分支。普通主线继续使用四项原有检查，紧急分支只要求其专用检查。两个分支都保留所有者合并限制、禁止 force push 和删除；工作流没有合并 bypass。

未合并准备结果的有效期为三十天，过期后不能取得准入。撤销清单的 `nextUpdate` 与工具渠道九十天有效期分别校验；密钥本身没有因此到期。合并后 Release 收尾不会续签撤销清单。

### 撤销清单续签

**Renew community revocations** 每周一 04:23 UTC 检查主线，也支持手动运行。没有已发布整代或有效期还超过七天时不写入；临近到期时，由 GitHub Actions 机器人在 `chore/community/revocations-renewal` 创建维护 PR，固定当前整代和撤销清单摘要。已有开放续签 PR 时返回原链接，不覆盖其中的修改；同一请求被关闭后不会自动重开，维护者可以重新打开原 PR。

维护者核对请求后，在 GitHub 提交 **Approve** Review，再运行 **Complete community review** 并批准 `release` Environment。签发器把新的三十天有效期、递增序号和签名追加到续签 PR，保留全部限制记录、历史包及归属；检查通过后使用 Merge commit 合并。机器人不能代替维护者审核，也不使用作者自审表单。创建 PR 本身尚未延长有效期。

仓库需要开启 Actions 的 **Allow GitHub Actions to create and approve pull requests**，默认 token 权限仍保持只读，需要写入或读取 Draft 的受保护 job 显式申请相应权限。准入只接受已授权自然人的审核，机器人批准不会放行。为避免 job token 抑制事件，续签入口显式启动该 PR 的静态检查与 Gate；它不会启动签名、自动合并或关闭普通申请。暂停此 workflow 会停止自动创建续签请求，已有清单仍按原有效期使用。

这类独立 PR 只负责无申请时的清单续签；插件发布、换钥、状态处置和转移继续在各自原申请 PR 内完成。

master 代码检查不读取开放 PR 列表。社区 Gate 只检查本次事件或显式指定的 PR；投稿向导查询开放请求进行查重和取消操作，紧急声明查找需要撤回旧准入的请求，周期清理读取开放请求以保护仍使用的归档。保护配置不授予工作流合并 bypass。
