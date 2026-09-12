# PixivDownloader 社区插件仓库

[English](README_en.md)

本仓库保存社区插件投稿、发布者身份、审核证据和发布记录。插件代码与安装包保留在发布者的源码仓库和固定发行资产中。

**当前只接受仓库所有者的工具、规则和文档维护 PR。** 插件投稿、扫描复核和签名发布尚未启用，相应请求保持阻断。

社区签名表示对应版本完成了约定的审核与字节核对，不保证插件没有漏洞或恶意行为。开发者能力声明来自包内 `pixiv.risk-signals`，执行模式也不等于操作系统沙箱。

## 贡献

请先阅读 [贡献说明](CONTRIBUTING.md)。普通投稿者的权限边界是 fork PR；维护工具、合同资源和发布结果使用独立维护流程。只有仓库所有者可以合并。

## 数据目录

| 路径 | 内容与写入者 |
|---|---|
| `submissions/` | 发布者提交的固定版本输入 |
| `key-rotations/`、`version-status-requests/`、`ownership-transfers/` | 独立换钥、版本状态与所有权申请 |
| `publishers/`、`plugin-bindings/` | 受保护流程生成的发布者记录与当前归属 |
| `reviews/`、`published/`、`revocations/` | 受保护审核、发布与撤销结果 |
| `generated/` | 从已批准源数据生成的目录与索引 |
| `schemas/`、`tools/`、`scripts/`、`.github/` | 维护者管理的固定合同、工具和平台入口 |

## 本地检查

安装 Node.js 24、JDK 17、Git 和 GitHub CLI 后运行：

```sh
npm test
npm run repository:plan
npm run labels:plan
```

标签预览需要可读取本仓库的 `gh` 登录。预览不会写入 GitHub；应用配置的维护命令另行要求显式参数。

测试使用随仓库固定的 SDK 工具和资源，无需下载 Maven 依赖。仓库工具采用 [AGPL-3.0-or-later](LICENSE)，插件本身使用各发布者声明的许可证。
