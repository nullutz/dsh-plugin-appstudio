# DSH App Studio

English | [简体中文](README.zh.md)

DSH App Studio is a visual app development workbench for DeepSeek Harness (DSH). It brings project scaffolding, live device preview, and agent-driven edits into the same workspace. Mark changes directly on a running app, collect comments across screens, and submit them together. Once the candidate passes validation, the live viewport switches to it so you can continue testing from the same scene.

The first release targets Android development on Windows with Flutter, React Native, and native Android. iOS and HarmonyOS will follow through their own platform adapters.

App Studio is a community plugin maintained by `nullutz`. [GitHub repository](https://github.com/nullutz/dsh-plugin-appstudio)

## Compatibility

- **DSH host.** App Studio `0.1.12` supports DSH Desktop with DeepSeek Harness `0.2.2-alpha.3` or `0.2.2-rc.1`. Check the bundled Harness version when using a desktop distribution with its own version numbering.
- **Android runtime.** Requires Windows x64, hardware virtualization, and WSL2 with KVM (`/dev/kvm`) available to the emulator. Windows 11 is the standard setup for WSL2 nested virtualization. If Windows runs in a VM, its hypervisor must also expose nested virtualization. [Microsoft WSL settings](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#main-wsl-settings)
- **Tested configuration.** The validation baseline records the Windows build, WSL, Electron, and Android versions used for testing. The requirements above describe the capabilities needed on other machines. [Validation baseline](runtime-lock.json)

## Install and set up

Open DSH Desktop once to initialize its profile, then fully quit it. Run the command below in PowerShell using the bundled `dsh.cmd` under `resources/runtime/cli/bin`. [DSH Desktop CLI documentation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/apps/desktop/README.md#bundled-command-runtime)

```powershell
dsh plugin --profile desktop add dsh-plugin-appstudio@0.1.12 --ignore-scripts
```

For a file-based install, download `dsh-plugin-appstudio-0.1.12.tgz` and run the following command from its directory. [GitHub Releases](https://github.com/nullutz/dsh-plugin-appstudio/releases)

```powershell
dsh plugin --profile desktop add .\dsh-plugin-appstudio-0.1.12.tgz --ignore-scripts
```

If the profile uses a development link, stop the Android runtime and run `dsh plugin --profile desktop remove dsh-plugin-appstudio` before installing the package. [npm package](https://www.npmjs.com/package/dsh-plugin-appstudio/v/0.1.12)

Open or restart DSH Desktop. In Plugin Manager, enable the `dsh-plugin-appstudio` and `dsh-plugin-appstudio/android` components, then open **App Studio** from the sidebar. Review and accept the Android SDK license, set up the runtime once, then select **Start Android Live**. On a cold start, App Studio starts the device that was showing the current app first and starts the other device in the background. Once both devices are ready, you can switch between them. When you switch to another DSH panel or session, App Studio keeps the preview connections open and reuses them when you return. Select **Stop runtime** when you finish testing. The SDK, tools, and emulator data stay available for the next run.

Initial setup imports a dedicated WSL2 distribution and downloads its Linux dependencies and Android SDK. Framework tools are downloaded when first needed. App Studio sizes each emulator for the CPU and memory available in WSL2. It uses hardware rendering when WSL2 exposes working D3D12 graphics and falls back to SwiftShader when needed. If setup or startup fails, open **Technical details** in the Android runtime panel for the error code and diagnostic output. **Repair runtime** can restore SDK or gateway files in an existing environment and reuse its device data.

## Run and rebuild an existing project

1. Enable the required framework components in DSH Plugin Manager. Enter the absolute local Windows project directory and choose **Flutter**, **React Native**, or **Native Android**. Native Android uses the Gradle wrapper and `:app:assembleDebug`. React Native also uses an npm lockfile and embeds the JavaScript bundle in its APK so the device can start without Metro.
2. Select **Run project**. App Studio copies source into the dedicated Linux environment and builds and installs an x86_64 debug APK. Initial setup for each framework downloads its toolchain. Build caches are reused on later runs.
3. Navigate and edit in the app, change the project source, then select **Rebuild and restore scene**. App Studio builds on the side while the current app remains available. It captures the current scene, deploys to the other device and checks the new process, installed version and restored state before switching. A failed build or restore leaves the active app available and shows the diagnostic output.

The app must implement the [debug scene interface](ARCHITECTURE.md#debug-scene-interface) in its Android debug build.

## Create an app in an empty folder

1. Enable **Agent** and either **Layout** or **Prompt** in DSH Plugin Manager. Set up the Android runtime and configure a default model in DSH. Choose an empty local workspace or a Git repository containing only `.git`, then select a framework.
2. Select **Create app → Design a layout** to add pages. Drag a component beside another to share a row, or between rows to insert a new one. Select a component to adjust its width. Drag the dotted background to pan and use the canvas controls to zoom. Select **Describe the app** to start from a written brief.
3. Enter an app name and select **Generate and run**. App Studio creates a dedicated DSH session, lets the Agent customize the isolated starter, then builds and launches the Android app. After it verifies the app's initial scene, it writes the files to your project and opens Live when the new video and input are ready.
4. If generation fails, check the log and repair it in the same session. The generated project includes the debug scene interface, so you can test the app and submit the first comment batch from Live.

## Comment and submit an iteration

1. Enable the Agent, commenting, and iterations components in DSH Plugin Manager. With a project running, enter **Comment Mode**. Click a point or drag a box and add a comment. Exit Comment Mode to navigate the app and return to mark another screen. Drafts are kept by project.
2. Choose or create an **App Studio** session under **Recent Sessions**. Open it in DSH to view the conversation. Select a model that accepts image input so it can receive the annotated frames.
3. Select **Submit iteration**. While the Agent edits an isolated copy, you can keep using the **Current app** and save comments for the next round. The candidate becomes the **Current app** once it restores the scene and its first frame and input are ready. The original device moves to the background. The workbench keeps the diff and any per-comment results.
4. If a build or restore fails, the workbench keeps the current Live app, candidate and diagnostics. Select **Retry build and restore** when the candidate source is ready, or **Continue fixing** to ask the Agent to edit it. If the project source has changed since submission, review the conflict and start a new batch from the updated project.

## Sessions and runtime

App Studio iteration sessions appear in the DSH session list under the project's Workspace after the first turn. Use the DSH session list to view ordinary sessions.

The dedicated Android runtime can suspend after the DSH preview connection and active jobs have ended. To remove or rebuild it, go to **App Studio → Settings → Android Runtime** and choose **Uninstall Runtime** or **Reinitialize Runtime**. The settings page shows which emulator data the operation will affect. Source code lives in the project directory. DSH stores comments and sessions separately from the runtime.

## Project documentation

- [Architecture](ARCHITECTURE.md)
- [Validated runtime baseline](runtime-lock.json)

## Build from source

Use Node.js 24 and pnpm 12.5.1.

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile desktop add link:./packages/appstudio --ignore-scripts
```

## License

App Studio source is available under the MIT License. The bundled Gradle Wrapper includes its license and notices. [MIT License](LICENSE) · [Gradle Wrapper license and notices](packages/appstudio/scaffold/common/GRADLE-LICENSE)
