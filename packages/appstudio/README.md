# DSH App Studio

Create, run and review Android apps in DeepSeek Harness. App Studio supports Flutter, React Native and native Android, with a live device preview and scene restoration between iterations.

App Studio is a community plugin maintained by `nullutz`. [GitHub repository](https://github.com/nullutz/dsh-plugin-appstudio)

Use DSH Desktop 0.2.2-rc.1 on Windows x64 with WSL2 and CPU virtualization. Install from npm using PowerShell.

```powershell
dsh plugin --profile desktop add dsh-plugin-appstudio@0.1.11 --ignore-scripts
```

For a file-based install, download `dsh-plugin-appstudio-0.1.11.tgz` and run this command from its directory. [GitHub Releases](https://github.com/nullutz/dsh-plugin-appstudio/releases)

```powershell
dsh plugin --profile desktop add .\dsh-plugin-appstudio-0.1.11.tgz --ignore-scripts
```

Restart DSH, enable App Studio, its Android component and a framework in Plugin Manager, then open App Studio from the sidebar. Accept the Android SDK license and set up the runtime. Initial setup needs network access. Open **Technical details** in the runtime panel if setup or startup fails.

## 简体中文

App Studio 在 DeepSeek Harness 中创建、运行和评审 Android 应用，支持 Flutter、React Native 和 Android 原生。

使用 DSH Desktop 0.2.2-rc.1、Windows x64、WSL2 和 CPU 虚拟化。用上面的 PowerShell 命令从 npm 安装，也可以下载 GitHub Release 中的 `.tgz` 安装。安装后重启 DSH，在插件管理器中启用 App Studio、Android 和所需框架。打开 App Studio，接受 Android SDK 许可并初始化运行环境。首次初始化需要联网。遇到问题可在运行环境面板展开「技术详情」。 [完整中文说明](https://github.com/nullutz/dsh-plugin-appstudio/blob/main/README.zh.md)

## License / 许可证

App Studio uses the MIT License. The bundled Gradle Wrapper includes its license and notices. [MIT License / MIT 许可证](https://github.com/nullutz/dsh-plugin-appstudio/blob/main/LICENSE) · [Gradle Wrapper license / Gradle Wrapper 许可证](https://github.com/nullutz/dsh-plugin-appstudio/blob/main/packages/appstudio/scaffold/common/GRADLE-LICENSE)
