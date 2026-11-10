# DSH App Studio

English | [简体中文](README.zh.md)

DSH App Studio is a visual app development workbench for DeepSeek Harness (DSH). It brings project scaffolding, live device preview, and agent-driven edits into the same workspace. Mark changes directly on a running app, collect comments across screens, and submit them together. Once the candidate passes validation, the live viewport switches to it so you can continue testing from the same scene.

The first release targets Android development on Windows with Flutter, React Native, and native Android. iOS and HarmonyOS will follow through their own platform adapters.

## Project status

This repository contains the product design, usage guide, and validated runtime baseline. The workflow below describes the planned plugin experience.

## Usage

1. **Enable the components you need.** In DSH Plugin Manager, enable App Studio and the scaffolding, Live, commenting, agent iteration, and framework components you need. Local Android development requires WSL2 and working nested virtualization. DSH guides you through setting up the dedicated runtime when you first enable Android.
2. **Open a project.** Open App Studio from the sidebar and choose a project directory. In an empty repository, you can arrange components on a canvas or describe the app and let the agent scaffold it. For an existing project, select its framework and run it. Existing projects integrate the debug scene interface to support automatic scene restoration.
3. **Run and comment.** Select **Run** to open Live. Mouse and keyboard input goes to the app by default. In **Comment Mode**, select a component or drag to mark an area and add a comment. Return to interaction mode to navigate to another screen. Your comments stay in the sidebar.
4. **Submit the iteration.** Select the project's iteration session and click **Submit Iteration**. The agent edits a candidate copy. Once the candidate builds, launches, and restores the current scene, App Studio applies the changes, updates Live, and shows the diff and the outcome of each comment. If validation fails, continue fixing the candidate in the same session.

## Sessions and runtime

App Studio iteration sessions appear in the DSH session list under the project's Workspace. Use **Recent Sessions** in App Studio to switch to an iteration session, create one for the current project, or open a regular DSH session for viewing.

The dedicated Android runtime stops when its work is finished. Installed tools and caches are available on the next run. To remove or rebuild it, go to **App Studio → Settings → Android Runtime** and choose **Uninstall Runtime** or **Reinitialize Runtime**. The settings page shows which emulator data the operation will affect. Source code lives in the project directory. DSH stores comments and sessions separately from the runtime.

## Project documentation

- [Architecture](ARCHITECTURE.md)
- [Validated runtime baseline](runtime-lock.json)
