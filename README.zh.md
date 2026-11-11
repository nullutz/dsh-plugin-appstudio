# DSH App Studio

[English](README.md) | 简体中文

DSH App Studio 是 DeepSeek Harness（DSH）的可视化 App 开发工作台。它把工程起稿、真实设备预览和 Agent 修改放进同一个工作区。用户可以直接在运行中的 App 上指出要改的位置，把跨页面的意见一次提交。新版通过验证后接管画布，用户从刚才的测试场景继续操作。

首发设计面向 Windows 上的 Android 开发，覆盖 Flutter、React Native 和 Android 原生工程。iOS 和 HarmonyOS 后续通过各自的平台适配接入。

App Studio 由 `nullutz` 维护，是一个 DSH 社区插件。 [GitHub 仓库](https://github.com/nullutz/dsh-plugin-appstudio)

## 安装与初始化

使用 DSH Desktop 0.2.2-rc.1。Android 环境要求 Windows x64、WSL2 和 CPU 虚拟化。Windows 运行在虚拟机里时，还需要启用嵌套虚拟化。首次初始化会下载 Ubuntu 基础镜像、Linux 依赖和 Android SDK，各框架的构建工具在首次使用时下载。

```powershell
dsh plugin --profile desktop add dsh-plugin-appstudio@0.1.11 --ignore-scripts
```

也可以下载 `dsh-plugin-appstudio-0.1.11.tgz`，在安装包所在目录运行以下命令。 [GitHub Releases](https://github.com/nullutz/dsh-plugin-appstudio/releases)

```powershell
dsh plugin --profile desktop add .\dsh-plugin-appstudio-0.1.11.tgz --ignore-scripts
```

如果这个配置已通过开发链接安装，先停止 Android 运行环境，再用 `dsh plugin --profile desktop remove dsh-plugin-appstudio` 移除该链接，随后安装发布包。 [npm 包](https://www.npmjs.com/package/dsh-plugin-appstudio/v/0.1.11)

打开或重启 DSH Desktop，在插件管理器中启用 `dsh-plugin-appstudio` 和 `dsh-plugin-appstudio/android` 两个组件，然后从左侧栏打开 **App Studio**。阅读并接受 Android SDK 许可，首次初始化后点击「启动 Android 实时预览」。冷启动时优先启动上次显示当前 App 的设备，另一台在后台启动。两台都就绪后可以手动切换。切到 DSH 其他面板或会话时，App Studio 保持预览连接，回来直接复用。测试结束后可点「停止运行环境」。SDK、工具和模拟器数据供下次复用。

App Studio 会根据 WSL2 可用的 CPU 和内存配置模拟器。D3D12 图形可用时启用硬件渲染，必要时自动回退到 SwiftShader。初始化或启动失败时，可以在「Android 运行环境」展开「技术详情」，查看故障代码和诊断信息。已安装环境的 SDK 或网关文件损坏时，可用「修复运行环境」复用已有设备数据。

## 运行和重建已有工程

1. 在 DSH 插件管理器中启用所需的框架组件。输入 Windows 本地工程目录的绝对路径，选择 Flutter、React Native 或 Android 原生。Android 原生使用工程的 Gradle wrapper 和 `:app:assembleDebug`。React Native 还需要 npm 锁文件，调试 APK 内置 JavaScript bundle，设备可以独立于 Metro 启动。
2. 点「运行工程」。App Studio 将源码复制到专用 Linux 环境，构建并安装 x86_64 调试 APK。每个框架首次运行时按需下载工具链，后续构建复用缓存。
3. 在 App 中进入测试场景并修改工程源码，再点「重建并恢复场景」。当前 App 在后台构建期间仍可操作。App Studio 捕获当前场景，在另一台设备部署，并核对新进程、安装版本和恢复结果后切换。构建或恢复失败时，当前 App 保持可用，工作台显示诊断日志。

工程的 Android 调试构建需要接入[调试场景接口](ARCHITECTURE.zh.md#调试场景接口)。

## 从空目录创建 App

1. 在 DSH 插件管理器中启用「Agent」以及「布局起稿」或「文字起稿」。初始化 Android 运行环境，并在 DSH 中配置默认模型。选一个空的本地工作目录，或仅含 `.git` 的仓库，再选框架。
2. 打开「创建应用 → 排布界面」添加页面。把组件拖到另一个组件侧边可并排，拖到两行之间可插入新行。选中组件可调整宽度。拖动点阵背景可平移画布，右下角可缩放。也可以切到「描述应用」，直接输入需求。
3. 输入 App 名称，点击「生成并运行」。App Studio 创建专用 DSH 会话，由 Agent 修改隔离的起稿工程，再构建并启动 Android App。验证初始场景后才写入工程目录，等新版画面和输入就绪后打开 Live。
4. 起稿失败时可查看日志，并在原会话续修。生成工程已内置调试场景接口，可以直接进入 Live 测试并提交第一轮评论。

## 评论和提交本轮

1. 在 DSH 插件管理器中启用 Agent、评论与迭代组件。工程运行后进入「评论模式」，点选或框选并输入评论。退出评论模式即可继续操作 App，切到其他页面后可再添加评论。草稿按工程保存。
2. 在「最近会话」选择或新建 App Studio 专用会话。可在 DSH 中打开查看会话。选择支持图片输入的模型，以便处理评论截图。
3. 点击「提交本轮」。Agent 修改独立候选副本时，你可以在「当前 App」继续操作和记录下一轮评论。候选恢复现场且首帧和输入就绪后，自动成为「当前 App」，原设备退到后台。工作台保留 diff 和逐条结果。
4. 构建或恢复失败时，工作台保留当前 Live、候选改动和日志。候选源码已就绪时，可点「重试构建和恢复」。需要改动候选源码时，可点「继续修复」。提交后若原工程发生外部改动，可查看冲突并基于当前工程发起新批次。

## 会话和环境

App Studio 专用会话完成首轮后会出现在 DSH 会话列表，跟随项目所在的 Workspace 分组。普通会话在 DSH 会话列表中查看。

DSH 预览连接关闭且当前任务完成后，专用 Android 环境可以休眠。要移除或重建环境，进入 **App Studio → 设置 → Android 运行环境**，选择「卸载环境」或「重新初始化环境」。设置页会显示受影响的模拟器数据。源码保存在项目目录，评论和会话由 DSH 工作区独立保存。

## 项目文档

- [架构说明](ARCHITECTURE.zh.md)
- [实测版本基线](runtime-lock.json)

## 从源码构建

使用 Node.js 24 和 pnpm 12.5.1。

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile desktop add link:./packages/appstudio --ignore-scripts
```

## 许可证

App Studio 源码使用 MIT 许可证。随附的 Gradle Wrapper 包含其许可证和声明。 [MIT 许可证](LICENSE) · [Gradle Wrapper 许可证和声明](packages/appstudio/scaffold/common/GRADLE-LICENSE)
