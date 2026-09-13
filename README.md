# PixivDownloader 社区插件仓库

[English](README_en.md)

本仓库保存社区插件投稿、发布者身份、审核证据和发布记录。发布者提供公开的固定源码与已签名安装包；社区独立重建并逐字节核对，将待审核包及证据保存到本仓库的 Draft Release。

版本投稿须通过静态检查、隔离重建、风险复核和当前 head 的人工审核。维护 PR 仅接受仓库所有者提交的工具、规则和文档修改。正式社区签名、公开目录发布及管理操作执行器尚未接通；通过审核或合并 PR 都不表示插件已发布。

社区签名表示对应版本完成了约定的审核与字节核对，不保证插件没有漏洞或恶意行为。开发者能力声明来自包内 `pixiv.risk-signals`，执行模式也不等于操作系统沙箱。

## 贡献

请先阅读 [贡献说明](CONTRIBUTING.md)。普通投稿者的权限边界是 fork PR；维护工具、合同资源和发布结果使用独立维护流程。只有仓库所有者可以合并。

## 数据目录

| 路径 | 内容与写入者 |
|---|---|
| `submissions/` | 发布者提交的固定版本输入 |
| `key-rotations/`、`version-status-requests/`、`ownership-transfers/` | 独立换钥、版本状态与所有权申请 |
| `ownership-transfer-evidence/<pluginId>/<sha256>.bin` | 所有权恢复请求引用的原始证据 |
| `publishers/`、`plugin-bindings/` | 受保护流程生成的发布者记录与当前归属 |
| `reviews/`、`published/`、`revocations/` | 受保护审核、发布与撤销结果 |
| `audits/<requestId>.json` | 受保护操作流程追加的执行审计，供状态与重复请求查询 |
| `generated/` | 从已批准源数据生成的目录与索引 |
| `schemas/`、`tools/`、`scripts/`、`.github/` | 维护者管理的固定合同、工具和平台入口 |

## 投稿与版本管理

安装 Git、GitHub CLI、Node.js 24 或更高版本，以及可运行 `java`、`javac`、`jar` 的 JDK 17。先登录 `gh`，并配置 Git 提交身份和 GitHub HTTPS 认证。在 Windows PowerShell 5.1 或 PowerShell 7 中进入您的 SDK 工程目录，再运行固定版本的入口：

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/30697cc721024224295ae79edb11b6ae1660c5cf/tools/submit.ps1' | iex
```

无需先克隆社区仓库。`irm` 取得上述固定提交的入口脚本；入口再按完整来源提交和清单 SHA-256 校验工具，逐文件验证后使用本地缓存，缺少文件时只从对应提交下载。缓存位于 `%LOCALAPPDATA%\PixivDownloader\community-tools`，不会执行可变分支上的工具。向导结束后返回当前终端，结果码保存在 `$LASTEXITCODE`。

需要保存脚本时，可下载同一 URL 后运行 `.\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`。可信完整仓库中的入口也可直接运行 `.\tools\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`。

`ProjectDirectory` 可以是 SDK 工程目录，或包含多个 SDK 工程的 Git 根目录。入口先检查 Git 跟踪的 `.pixivdownloader-plugin-project` 标识，缺少时退出并显示：

> 未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录

向导支持简体中文、繁體中文、English、日本語和한국어。版本投稿需要干净且已公开的源码 commit、已构建的最终插件包，以及与本地包字节相同的公开 HTTPS 下载地址或 GitHub Release 资产。选择工程及构建 profile 后，只有确认信任当前工程才会调用 Maven、Gradle 或 sbt 查询实际模型。模型查询可以执行工程配置和构建插件，使用当前本地账号权限，无需容器；它不会替您完成插件构建。

向导从模型、最终包和 GitHub 原生数据取得版本、摘要与身份，自动识别首次发布和更新。风险声明来自包内 `pixiv.risk-signals`；需要修改时返回源码重建。许可证、发布者名称、市场文案和组织代表权由您确认。缺少许可证时可生成固定许可证文本，提交源码并重新构建后再投稿。

已有发布者选择不同密钥时，向导生成独立换钥请求。主菜单也支持 YANK、UNYANK、REVOKE 和所有权转移；UNYANK 自动引用当前有效的 YANK 决定，转移双方分别以自己的账号提交申请或确认。新建密钥和已有私钥都须保存在 Git 仓库及临时目录之外，请自行备份。

最后预览会列出身份、目标 fork、分支、全部文件的路径和摘要、JSON 正文及 PR 信息。主动选择“确认并继续”并按 Enter 后，向导重新核对账号、base、绑定和内容，再创建所需 fork、提交、普通推送并创建 Ready PR。取消预览不会写入 GitHub。中断后可重新运行，已有内容必须完全匹配才会复用；向导不自动批准或合并 PR。换钥、状态和转移申请仍须等待各自的受保护执行器。

向导使用 Clack 交互组件：方向键移动，Enter 选择，标签用空格勾选，Esc 或 Ctrl+C 取消。文本默认值可以编辑；必填项、HTTPS 地址和密钥路径等输入出错时，可在当前问题中修正。加载步骤显示状态，最终确认前展示提交摘要和完整预览。工程执行、密钥生成、组织代表权和提交等确认默认选择“取消”，必须用方向键切换到“确认并继续”后按 Enter；直接回车不会执行操作。可选签名证明默认跳过。

在可信源码仓库根目录运行 `npm run submit:demo` 可体验同一套交互组件。演示只使用示例数据，不访问 GitHub、不执行构建、不签名，也不写入文件。要从源码运行实际向导，使用 `node scripts/submit.mjs 'D:\Plugins\example'`；该命令会执行正常的项目检查与投稿流程。

Clack 及其运行依赖已打包到工具清单内，投稿时无需运行 npm 安装。维护者更新依赖时运行 `npm ci --ignore-scripts`、`npm run bundle:ui` 和 `node scripts/submission-manifest.mjs --write`；`node scripts/bundle-submission-ui.mjs --check` 检查打包结果是否与锁文件一致。生成文件内保留第三方许可证。发布入口须同时固定工具来源提交和清单摘要，再将教程中的 `irm` 地址固定到包含该入口的实际提交。

## 构建与审核

`Submission static check` 从受保护 workflow 的精确源码 SHA 运行，先读取 PR 原生身份、base/head 和新增 Git blob，检查路径、固定 SDK Schema、源码归档、公开安装包的实际大小与摘要、发布者签名和静态图片。这部分只解析数据，候选代码不进入检查器 classpath。

版本投稿随后在一次性的 GitHub 托管 Ubuntu runner 上构建。固定摘要的容器最多使用 2 CPU、6 GiB 内存、12 GiB 可写磁盘和 512 个进程，每次构建限时 30 分钟。Maven、Gradle、sbt profile 执行各自的构建与测试任务；预取只经代理访问批准的公共制品源，正式重建恢复原始源码并关闭网络。容器不接收 Secret、GitHub token、Docker socket 或共享可写缓存。重建包必须与发布者的原包逐字节一致。

预取代理使用按 SHA-256 固定的 Ubuntu OpenSSL 工具，核对 CONNECT、TLS 和 HTTP 请求中的目标，只转发批准主机的 HTTPS GET/HEAD，并验证源站证书。构建容器只读本次临时 CA 的公钥证书与信任库；私钥仅挂给代理并在结束时移除，不修改开发者或 runner 的系统信任库。

扫描器读取最终包的 JVM 调用指令，不加载插件类。报告保留精确方法符号、位置、包摘要和原始调用证据，并分别标记插件编译输出、私有依赖和无法确定归属的类。只有规则覆盖的直接调用可产生缺报发现；未命中不代表不存在相应行为。坏 class 或扫描失败显示 `INCOMPLETE`，已发现的问题继续保留。SBOM 清点实际包与构建缓存，依赖许可证声明仍须人工复核。

构建 job 只有读取权限，不使用 Secret。成功后将包、源码和证据交接为保留七天的 Actions artifact。受保护的 `Community candidate archive` 独立验证原生执行来源及全部字节，将它们存入“待审核” Draft Release，并用 GitHub artifact attestation 证明归档来源。待审核资产名包含稳定发布者 ID，例如 `pixivdownload-plugin-alice-example-plugin-1.2.0.jar`。Draft 不进入公开目录，也不授予 `SOURCE_REVIEWED`。

等待人工审核或重试时复用已验证的归档字节。新 head 必须重新审核；源码、包或构建输入变化时重新构建，只有规则变化时可复用原包重新扫描。归档缺失、摘要冲突或来源无法验证会阻断，不能回退到未经核验的缓存。原生 Request changes 仍优先阻断；自审、误报和人工补扫各自使用受保护表单，操作方式见 [贡献说明](CONTRIBUTING.md#检查与表单)。

换钥、版本状态与所有权转移分别校验，不能与版本投稿混在一个 PR 中。状态查询验证 `audits/<requestId>.json` 的请求及决定原始摘要，UNYANK 只引用当前有效的 YANK 决定。

## 本地检查

安装 Node.js 24、JDK 17、Git 和 GitHub CLI 后运行：

```sh
npm test
npm run repository:plan
npm run labels:plan
```

标签预览需要可读取本仓库的 `gh` 登录。预览不会写入 GitHub；应用配置的维护命令另行要求显式参数。

测试使用随仓库固定的 SDK 工具和资源，无需下载 Maven 依赖。仓库工具采用 [AGPL-3.0-or-later](LICENSE)，插件本身使用各发布者声明的许可证。
