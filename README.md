# PixivDownloader 社区插件仓库

[English](README_en.md)

本仓库接收并发布 PixivDownloader 开源社区插件。将插件源码推送到公开 GitHub 仓库并等待候选 CI 通过后，直接在你自己的 SDK 工程目录运行投稿向导即可，无需克隆本仓库或手写投稿文件。

- 首次投稿或发布新版本：见[投稿与版本管理](#投稿与版本管理)。
- 下架、恢复、撤销、换钥、声明密钥泄露或转移所有权：见[管理已登记插件](#管理已登记插件)。
- 仓库维护与审核流程：见[贡献说明](CONTRIBUTING.md)。

普通版本投稿在获得维护者对当前 PR head 的原生 `Approve` 后，受保护工作流会自动等待静态检查、隔离重建与候选归档完成，生成签名目录、核验四项 Gate 检查并合并 PR，随后公开社区 Release。源码仓库的候选 Draft Release 和审核中的社区 Draft 均不代表已获社区准入。

## 开源准入

本仓库仅收录开源插件，每个投稿版本必须满足：

1. **完整可复现源码**：在公开、未归档的 GitHub 仓库提供与提交 commit 和插件包对应的完整源码与构建输入，使社区隔离环境能够重建并核对包字节；仅提供可下载的 JAR / ZIP 或 Release 不予准入。
2. **合规开源许可证**：包含符合 [OSI 开源定义](https://opensource.org/osd)的许可证（如 MIT）及必要版权声明，覆盖实际提交的代码与产物，并与依赖许可证义务相容。SPDX 语法与摘要检查仅验证声明格式，自定义或组合许可证及兼容性仍由维护者人工审核。

## 投稿与版本管理

### 1. 推送源码并等待候选 CI

1. 基于 [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK) 开发插件，提交开源许可证，并保留 SDK 工程标识与 `Plugin candidate` 工作流（旧工程需先升级配套工具并补齐该工作流）。
2. 将源码推送到公开仓库的默认分支，等待 **Plugin candidate** 全部作业通过（CI 会执行测试、离线复现检查，并在每个插件唯一的 Draft Release 中更新候选产物）。
3. 保持本地工作树干净，固定构建工具、依赖与打包时间，在与 CI 同一提交上启动投稿向导。

### 2. 准备本地环境

安装 Git（已配置 `user.name` 与 `user.email`）、GitHub CLI、Node.js 24+ 与 JDK 17+（确保终端中的 `java`、`javac`、`jar` 均来自 JDK 17+）。在 Windows PowerShell 5.1 或 PowerShell 7 中首次登录 GitHub CLI：

```powershell
gh auth login
gh auth setup-git
```

- **权限要求**：若推送时提示 `GIT_WORKFLOW_SCOPE_REQUIRED`，说明当前 Git 凭据缺少工作流写权限。使用 GitHub CLI OAuth 时执行 `gh auth refresh --hostname github.com --scopes workflow`；使用 classic PAT 需勾选 `workflow`，fine-grained PAT 需授予 `Workflows: write`。
- **代理与缓存**：默认读取 `NO_PROXY`、`HTTPS_PROXY` / `ALL_PROXY` 或 Windows 系统 HTTP/HTTPS 代理。向导首次运行时按签名清单获取并校验固定技术依赖（无需下载完整 SDK ZIP），后续运行复验并复用本地缓存。

### 3. 运行投稿向导

在你的 SDK 工程目录执行（请将路径替换为实际工程目录）：

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submit.ps1' | iex
```

1. **选择版本投稿**：向导自动识别工程并拉取当前提交的 CI 候选包核对字节（Actions 产物过期时读取 Draft Release；缺失时可确认重跑默认分支当前提交的 CI）。
2. **核对元数据与许可证**：确认插件版本、能力声明、SPDX 许可证（可选用现有文件或从内置模板创建）、发布者身份以及多语言介绍、分类和标签。
3. **签名候选包**：选择已有 Ed25519 私钥或生成新密钥对（私钥必须保存在 Git 仓库和临时目录之外并自行备份；支持设置私钥保护口令，向导不保存口令）。
4. **预览并提交**：核对摘要与完整预览后确认执行。向导将候选包固定到绑定源码 commit 的 Pre-release，自动准备 fork、提交分支并创建投稿 PR。

**向导操作与断点恢复**：方向键移动、`Enter` 确认、`Space` 勾选、`Ctrl+B` 返回上一步、`Ctrl+S` 保存退出、`Esc` / `Ctrl+C` 取消；所有远端写入均需显式确认（默认取消）。未完成进度按账号、仓库、工程与插件 ID 保存在 `%LOCALAPPDATA%\PixivDownloader\community-submission\projects\`（密钥路径索引按发布者保存在同级 `publishers\`），下次运行可从断点继续；会话期间若社区主线推进，向导会自动重读最新状态并重验（每次操作最多自动恢复 3 轮）。

### 4. 附加市场文档、图片与链接（可选）

- **外链与更新说明**：可配置主页、文档、反馈等链接（支持增删或留空）。向导默认从冻结源码提交的 `CHANGELOG.md` 中按当前版本二级标题（如 `## [v1.2.0] - 2026.10.01`）提取本次更新说明，找不到或重复时可重选文件、手动输入或跳过；也可同时附带完整 `CHANGELOG.md`。
- **README 与图片**：支持从冻结源码、本地文件或终端多行输入导入 UTF-8 Markdown / HTML（`Enter` 换行，`Tab` 后按 `Enter` 提交）。相对图片须位于选定根目录内，外部 HTTPS 图片需确认下载。
- **发布校验**：确认投稿后，文档与图片先暂存到源码仓库的 `market-content-<plugin>-<version>` Release；审核通过后随插件包复制到同一社区版本 Release 并校验 SHA-256 与公开可读性。客户端以净化后的静态隔离文档展示。

### 5. 等待审核与版本更新

在投稿 PR 中查看四项准入检查与审核意见。仅等待审核无需重新构建；若修改了源码、许可证或构建输入，需重新推送、等待新 CI 通过并重新运行向导。排队期间社区主线的无关数据更新由工作流自动合并，无需投稿者手动同步分支。发布后续新版本时，升级版本号并推送通过 CI 后运行同一向导命令即可（自动带出既有许可证、多语言简介与图片）。

## 管理已登记插件

仅执行管理操作时，可在任意普通目录运行上述 `irm ... | iex` 命令（无 SDK 工程标识时仅开放管理菜单，进度保存在 `%LOCALAPPDATA%\PixivDownloader\community-submission\management\`）：

| 管理操作 | 作用与授权规则 |
| --- | --- |
| 取消未合并请求 | 关闭本人尚未合并的 PR，并可单独确认删除对应请求分支（保留 fork、默认分支、Release 与本地记录） |
| 下架（`YANK`）与恢复（`UNYANK`） | `YANK` 阻止新安装；修复后可用 `UNYANK` 解除自己发起的下架（社区独立限制仍保留）。当前个人所有者使用活动私钥签名后由工作流自动核验合并 |
| 撤销版本（`REVOKE`） | 永久阻止安装与启动（不可恢复，需输入 `插件ID@版本` 确认），核验归档后移除公开安装包附件。个人所有者使用活动私钥签名后自动执行 |
| 轮换密钥（`ROUTINE_ROTATION`） | 个人账号提供新旧两把私钥对同一请求正文的签名证明时可自动处理（旧密钥标为 `RETIRED`）；密钥遗失、泄露后换钥或组织账号需人工审核 |
| 声明密钥泄露 | 选择已登记公钥（无需私钥）提交至受保护 `emergency-state` 分支；个人所有者本人或经核实的组织管理员可自动生效，立即封禁该公钥的新操作和待处理操作（不可撤回；若活动密钥被封禁，须换钥才能继续投稿） |
| 转移所有权 | 接收方输入 `原发布者ID/插件ID`（如 `sywyar/douyin`）并用自己密钥创建申请 PR；原所有者在向导中选择同意（可用活动私钥签署证明，不同个人账号双方签名有效时自动合并；或在网页提交 Approve 走人工审核）或拒绝（自动关闭 PR）。若列表中未找到待确认转移申请，可在列表末尾选择「修改筛选范围」取消标签或 `@` 条件后重查 |

有效的原生 `Request changes` 仍会阻断管理请求的自动处理；签名证明不能覆盖人工拒绝或社区独立限制。

## 帮助与许可证

投稿或管理遇到问题请在 [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues) 提问。本仓库治理与向导工具采用 [AGPL-3.0-or-later](LICENSE)，收录的各插件适用其各自声明的开源许可证。
