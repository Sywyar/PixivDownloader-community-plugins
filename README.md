# PixivDownloader 社区插件仓库

[English](README_en.md)

这里接收 PixivDownloader 插件投稿。准备好公开源码和插件包后，在自己的源码工程中运行投稿向导，即可创建审核 PR，无需克隆本仓库或手写投稿文件。

> 当前支持投稿与审核。社区签名、市场上架和版本管理操作的执行尚未接通，审核通过或合并 PR 暂不代表插件已上架。

## 投稿与版本管理

### 1. 准备源码和插件包

- 使用 [Plugin SDK](https://github.com/Sywyar/PixivDownloader-Plugin-SDK) 开发插件，将源码推送到公开 GitHub 仓库，保持工作树干净。提交许可证和 SDK 工程中的 `.pixivdownloader-plugin-project` 标识。
- 用工程的 Maven、Gradle 或 sbt 构建并通过测试，保留最终 JAR / ZIP。包内版本须与工程版本一致，能力声明须符合实际行为。向导会读取这些信息，不会替您构建插件。
- 将同一个包上传到源码仓库的公开 Release；预发布版本可用 Pre-release，不能保留为 Draft。也可以提供其他公开 HTTPS 下载地址。本地包与下载包必须完全一致，请勿覆盖同版本附件。

社区会从提交的源码重新构建并核对包字节。请固定构建工具、依赖和打包时间等输入，避免本地与社区环境差异导致包不一致。

### 2. 准备投稿环境

安装 Git、GitHub CLI、Node.js 24+ 和 JDK 17，确保终端可以运行 `java`、`javac`、`jar`。使用 Windows PowerShell 5.1 或 PowerShell 7，首次使用 GitHub CLI 时执行：

```powershell
gh auth login
gh auth setup-git
```

Git 还需配置提交用的 `user.name` 和 `user.email`。

### 3. 运行投稿向导

进入自己的 SDK 工程目录，把示例路径替换为实际路径：

```powershell
Set-Location -LiteralPath 'D:\Plugins\example'
irm 'https://raw.githubusercontent.com/Sywyar/PixivDownloader-community-plugins/master/tools/submit.ps1' | iex
```

按提示完成以下内容：

1. 选择版本投稿、工程、构建配置和最终插件包。确认信任本地工程后，向导会调用构建工具读取工程信息。
2. 核对插件版本、能力声明和许可证，选择自己的 GitHub 发布者身份，填写插件介绍等展示信息。
3. 选择已有签名密钥或生成新密钥，再选择上传的 Release 附件或填写下载地址。向导会比对公开包与本地包，并自动生成投稿签名。
4. 检查完整预览，选择“确认并继续”。向导随后创建所需的 fork、提交和推送投稿文件，并创建审核 PR。

私钥须保存在 Git 仓库和临时目录之外，并自行备份，后续版本仍需使用。若需修改包内版本或能力声明，请回到源码修改、重新构建并上传。

方向键移动，Enter 选择，空格勾选标签，Esc 或 Ctrl+C 取消。确认项默认取消；最终确认前不会提交到 GitHub。

### 4. 等待审核

在 PR 中查看检查结果和审核意见。社区会检查投稿、重建插件包、扫描声明并进行人工审核。仅等待审核不需要再次构建；源码、包或构建输入改变后需要重建并重新审核。

更新插件时，准备新版本的源码和包，再运行同一入口。换钥、下架、恢复、撤销和转移所有权使用向导中的独立管理选项。

## 帮助与维护

投稿遇到问题可在 [Issues](https://github.com/Sywyar/PixivDownloader-community-plugins/issues) 提问。审核表单和仓库维护操作见[贡献说明](CONTRIBUTING.md)。仓库工具采用 [AGPL-3.0-or-later](LICENSE)，插件使用各自声明的许可证。
