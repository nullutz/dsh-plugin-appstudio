# DSH App Studio

[English](README.md) | 简体中文

DSH App Studio 是 DeepSeek Harness（DSH）的可视化 App 开发工作台。它把工程起稿、真实设备预览和 Agent 修改放进同一个工作区。用户可以直接在运行中的 App 上指出要改的位置，把跨页面的意见一次提交。新版通过验证后接管画布，用户从刚才的测试场景继续操作。

首发设计面向 Windows 上的 Android 开发，覆盖 Flutter、React Native 和 Android 原生工程。iOS 和 HarmonyOS 后续通过各自的平台适配接入。

## 当前状态

DSH 工作台可以从布局草稿或文字需求创建 Android 工程，管理专用 WSL2 环境，并通过双模拟器提供实时画面和键鼠交互。Flutter、React Native 和 Android 原生工程可以构建、部署和恢复测试场景。起稿和评论批次都使用 App Studio 专用会话。

## 从源码运行

使用 Node.js 24、pnpm 12.5.1 和 DSH Desktop 0.2.2-rc.1。Android 环境还需要 Windows x64、WSL2、可用的嵌套虚拟化，以及首次配置时的网络连接。

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile desktop add link:./packages/appstudio --ignore-scripts
```

使用本地安装包时，在压缩包所在目录运行 `dsh plugin --profile desktop add .\dsh-plugin-appstudio-0.1.0.tgz --ignore-scripts`。如果这个配置已通过开发链接安装，先停止 Android 环境，再用 `dsh plugin --profile desktop remove dsh-plugin-appstudio` 移除该链接，随后安装压缩包。

打开或重启 DSH Desktop，在插件管理器中启用 `dsh-plugin-appstudio` 和 `dsh-plugin-appstudio/android` 两个组件，然后从左侧栏打开 **App Studio**。阅读并接受 Android SDK 许可，首次初始化后点击「启动 Android 实时预览」。可在「当前设备」和「候选设备」之间切换并操作两台设备。点击「停止运行环境」可以立即关闭。没有工作台连接时，环境也会在 30 秒后自动关闭。SDK、工具和模拟器数据供下次复用。

## 运行和重建已有工程

1. 在 DSH 插件管理器中启用所需的框架组件。输入 Windows 本地工程目录的绝对路径，选择 Flutter、React Native 或 Android 原生。Android 原生使用工程的 Gradle wrapper 和 `:app:assembleDebug`。React Native 还需要 npm 锁文件，调试 APK 内置 JavaScript bundle，设备可以独立于 Metro 启动。
2. 点「运行工程」。App Studio 将源码复制到专用 Linux 环境，构建并安装 x86_64 调试 APK。每个框架首次运行时按需下载工具链，后续构建复用缓存。
3. 在 App 中进入测试场景并修改工程源码，再点「重建并恢复场景」。当前 App 在后台构建期间仍可操作。App Studio 捕获当前场景，在另一台设备部署，并核对新进程、安装版本和恢复结果后切换。构建或恢复失败时，当前 App 保持可用，工作台显示诊断日志。

工程的 Android 调试构建需要接入[调试场景接口](ARCHITECTURE.zh.md#调试场景接口)。

## 从空目录创建 App

1. 在 DSH 插件管理器中启用「Agent」以及「布局起稿」或「文字起稿」。初始化 Android 运行环境，并在 DSH 中配置默认模型。选一个空的本地工作目录，或仅含 `.git` 的仓库，再选框架。
2. 在「布局起稿」中添加页面，将组件拖进手机画布并调整顺序。也可以用键盘添加和移动组件。在「文字起稿」中直接描述需要的 App。
3. 输入 App 名称并提交。App Studio 创建专用 DSH 会话，由 Agent 修改隔离的起稿工程，再构建并启动 Android App。验证初始场景后才写入工程目录，等新版画面和输入就绪后打开 Live。
4. 起稿失败时可查看日志，并在原会话续修。生成工程已内置调试场景接口，可以直接进入 Live 测试并提交第一轮评论。

## 评论和提交本轮

1. 在 DSH 插件管理器中启用 Agent、评论与迭代组件。工程运行后进入「评论模式」，点选或框选并输入评论。退出评论模式即可继续操作 App，切到其他页面后可再添加评论。草稿按工程保存。
2. 在「最近会话」选择或新建 App Studio 专用会话。可在 DSH 中打开查看会话。选择支持图片输入的模型，以便处理评论截图。
3. 点击「提交本轮」。Agent 在独立候选副本中修改。App Studio 在另一台设备构建、验证并恢复当前场景，通过后写回源码、切换 Live，并保留 diff 和逐条结果。
4. 构建或恢复失败时，工作台保留当前 Live、候选改动和日志。可用「在原会话修复」继续修改失败候选。提交后若源码有外部改动，可先查看冲突，再基于当前工程发起新批次。

## 会话和环境

App Studio 专用会话完成首轮后会出现在 DSH 会话列表，跟随项目所在的 Workspace 分组。普通会话在 DSH 会话列表中查看。

平时关闭 Live 后，专用 Android 环境按需停止，已安装工具和缓存供下次使用。要移除或重建环境，进入 **App Studio → 设置 → Android 运行环境**，选择「卸载环境」或「重新初始化环境」。设置页会显示受影响的模拟器数据。源码保存在项目目录，评论和会话由 DSH 工作区独立保存。

## 项目文档

- [架构说明](ARCHITECTURE.zh.md)
- [实测版本基线](runtime-lock.json)
