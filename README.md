# DSH App Studio

English | [简体中文](README.zh.md)

DSH App Studio is a visual app development workbench for DeepSeek Harness (DSH). It brings project scaffolding, live device preview, and agent-driven edits into the same workspace. Mark changes directly on a running app, collect comments across screens, and submit them together. Once the candidate passes validation, the live viewport switches to it so you can continue testing from the same scene.

The first release targets Android development on Windows with Flutter, React Native, and native Android. iOS and HarmonyOS will follow through their own platform adapters.

## Project status

The DSH workbench creates Android projects from a visual draft or a text brief, manages the dedicated WSL2 environment, and streams two emulators with mouse and keyboard input. It builds, deploys, and restores scenes for Flutter, React Native, and native Android. Generation and comment batches run in dedicated DSH sessions.

## Run from source

Use Node.js 24, pnpm 12.5.1, and DSH Desktop 0.2.2-rc.1. Android also requires Windows x64, WSL2, nested virtualization, and network access for initial setup.

```powershell
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile desktop add link:./packages/appstudio --ignore-scripts
```

To install a local package, run `dsh plugin --profile desktop add .\dsh-plugin-appstudio-0.1.0.tgz --ignore-scripts` from the package directory. If this profile already uses a development link, stop the runtime and remove that link with `dsh plugin --profile desktop remove dsh-plugin-appstudio` before adding the package.

Open or restart DSH Desktop. In Plugin Manager, enable the `dsh-plugin-appstudio` and `dsh-plugin-appstudio/android` components, then open **App Studio** from the sidebar. Review and accept the Android SDK license, set up the runtime once, then select **Start Android Live**. Switch between **Live device** and **Candidate device** to interact with the two devices. Use **Stop runtime** to stop immediately. The runtime also stops after 30 seconds without a workbench connection. The SDK, tools, and emulator data stay available for the next run.

## Run and rebuild an existing project

1. Enable the required framework components in DSH Plugin Manager. Enter the absolute local Windows project directory and choose **Flutter**, **React Native**, or **Native Android**. Native Android uses the Gradle wrapper and `:app:assembleDebug`. React Native also uses an npm lockfile and embeds the JavaScript bundle in its APK so the device can start without Metro.
2. Select **Run project**. App Studio copies source into the dedicated Linux environment and builds and installs an x86_64 debug APK. Initial setup for each framework downloads its toolchain. Build caches are reused on later runs.
3. Navigate and edit in the app, change the project source, then select **Rebuild and restore scene**. App Studio builds on the side while the current app remains available. It captures the current scene, deploys to the other device and checks the new process, installed version and restored state before switching. A failed build or restore leaves the active app available and shows the diagnostic output.

The app must implement the [debug scene interface](ARCHITECTURE.md#debug-scene-interface) in its Android debug build.

## Create an app in an empty folder

1. Enable **Agent** and either **Layout** or **Prompt** in DSH Plugin Manager. Set up the Android runtime and configure a default model in DSH. Choose an empty local workspace or a Git repository containing only `.git`, then select a framework.
2. Open **Layout** to add pages, drag components into the phone preview, and reorder them. You can also add and move components with the keyboard. Open **Prompt** to describe the app in text.
3. Enter an app name and submit. App Studio creates a dedicated DSH session, lets the Agent customize the isolated starter, then builds and launches the Android app. After it verifies the app's initial scene, it writes the files to your project and opens Live when the new video and input are ready.
4. If generation fails, check the log and repair it in the same session. The generated project includes the debug scene interface, so you can test the app and submit the first comment batch from Live.

## Comment and submit an iteration

1. Enable the Agent, commenting, and iterations components in DSH Plugin Manager. With a project running, enter **Comment Mode**. Click a point or drag a box and add a comment. Exit Comment Mode to navigate the app and return to mark another screen. Drafts are kept by project.
2. Choose or create an **App Studio** session under **Recent Sessions**. Open it in DSH to view the conversation. Select a model that accepts image input so it can receive the annotated frames.
3. Select **Submit iteration**. The Agent edits an isolated copy. App Studio builds and validates it on the second device, restores the active test scene, then applies the validated source changes and switches Live. The workbench keeps the diff and any per-comment results.
4. If a build or restore fails, the workbench keeps the current Live app, candidate and diagnostics. Use **Repair in the same session** to continue from the failed candidate. If the source has changed since submission, review the conflict and start a new batch from the updated project.

## Sessions and runtime

App Studio iteration sessions appear in the DSH session list under the project's Workspace after the first turn. Use the DSH session list to view ordinary sessions.

The dedicated Android runtime stops when its work is finished. Installed tools and caches are available on the next run. To remove or rebuild it, go to **App Studio → Settings → Android Runtime** and choose **Uninstall Runtime** or **Reinitialize Runtime**. The settings page shows which emulator data the operation will affect. Source code lives in the project directory. DSH stores comments and sessions separately from the runtime.

## Project documentation

- [Architecture](ARCHITECTURE.md)
- [Validated runtime baseline](runtime-lock.json)
