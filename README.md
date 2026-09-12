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
