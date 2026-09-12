# PixivDownloader 社区插件仓库

[English](README_en.md)

本仓库保存社区插件投稿、发布者身份、审核证据和发布记录。插件代码与安装包保留在发布者的源码仓库和固定发行资产中。

**当前准入只接受仓库所有者的工具、规则和文档维护 PR。** 数据 PR 已有独立静态检查；源码审阅、隔离重建和签名发布尚未接通，静态通过不会解除准入阻断。

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
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/97aa09a469748719fb365065cff81e432ab89032/tools/submit.ps1' | iex
```

无需先克隆社区仓库。`irm` 取得上述固定提交的入口脚本；入口再按完整来源提交和清单 SHA-256 校验工具，逐文件验证后使用本地缓存，缺少文件时只从对应提交下载。缓存位于 `%LOCALAPPDATA%\PixivDownloader\community-tools`，不会执行可变分支上的工具。向导结束后返回当前终端，结果码保存在 `$LASTEXITCODE`。

需要保存脚本时，可下载同一 URL 后运行 `.\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`。可信完整仓库中的入口也可直接运行 `.\tools\submit.ps1 -ProjectDirectory 'D:\Plugins\example'`。

`ProjectDirectory` 可以是 SDK 工程目录，或包含多个 SDK 工程的 Git 根目录。入口先检查 Git 跟踪的 `.pixivdownloader-plugin-project` 标识，缺少时退出并显示：

> 未检测到项目标识，您的SDK版本可能低于3600837c或非SDK目录

向导支持简体中文、繁體中文、English、日本語和한국어。版本投稿需要干净且已公开的源码 commit、已构建的最终插件包，以及与本地包字节相同的公开 HTTPS 下载地址或 GitHub Release 资产。选择工程及构建 profile 后，只有确认信任当前工程才会调用 Maven、Gradle 或 sbt 查询实际模型。模型查询可以执行工程配置和构建插件，使用当前本地账号权限，无需容器；它不会替您完成插件构建。

向导从模型、最终包和 GitHub 原生数据取得版本、摘要与身份，自动识别首次发布和更新。风险声明来自包内 `pixiv.risk-signals`；需要修改时返回源码重建。许可证、发布者名称、市场文案和组织代表权由您确认。缺少许可证时可生成固定许可证文本，提交源码并重新构建后再投稿。

已有发布者选择不同密钥时，向导生成独立换钥请求。主菜单也支持 YANK、UNYANK、REVOKE 和所有权转移；UNYANK 自动引用当前有效的 YANK 决定，转移双方分别以自己的账号提交申请或确认。新建密钥和已有私钥都须保存在 Git 仓库及临时目录之外，请自行备份。

最后预览会列出身份、目标 fork、分支、全部文件的路径和摘要、JSON 正文及 PR 信息。输入 `YES` 后，向导重新核对账号、base、绑定和内容，再创建所需 fork、提交、普通推送并创建 Ready PR。取消预览不会写入 GitHub。中断后可重新运行，已有内容必须完全匹配才会复用；向导不自动批准或合并 PR。当前数据准入仍受本文开头说明的限制。

## 本地检查

`Submission static check` 从受保护 workflow 的精确源码 SHA 运行，只读取 PR 原生身份、base/head 和新增 Git blob。它重新检查路径、固定 SDK Schema、源码归档、公开安装包的实际大小与摘要、发布者签名和静态图片。候选代码不进入 classpath，也不执行 Maven、Gradle 或 sbt。

检查只有读取权限，不使用 Secret。通过后保存静态输入 artifact 七天；结果表示 `STATIC_VALIDATED`，不表示已审核源码或获准发布。换钥、版本状态与所有权转移分别校验，不能与版本投稿混在一个 PR 中。状态查询验证 `audits/<requestId>.json` 的请求及决定原始摘要，UNYANK 只引用当前有效的 YANK 决定。

安装 Node.js 24、JDK 17、Git 和 GitHub CLI 后运行：

```sh
npm test
npm run repository:plan
npm run labels:plan
```

标签预览需要可读取本仓库的 `gh` 登录。预览不会写入 GitHub；应用配置的维护命令另行要求显式参数。

测试使用随仓库固定的 SDK 工具和资源，无需下载 Maven 依赖。仓库工具采用 [AGPL-3.0-or-later](LICENSE)，插件本身使用各发布者声明的许可证。
