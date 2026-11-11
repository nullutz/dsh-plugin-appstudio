# DSH App Studio Architecture

English | [简体中文](ARCHITECTURE.zh.md)

App Studio makes the running app the entry point for an agent-driven iteration. The user supplies a selection and an intent, the agent edits project source, and the workbench validates the candidate and restores the current test scene. The first release runs Android apps on Windows and covers Flutter, React Native, and native Android. iOS and HarmonyOS extend the same platform session interface.

## Plugin components

App Studio ships as one Cordis bundle. The React and TypeScript client mounts the workbench in DSH's sidebar navigation and main panel slots. It calls the TypeScript host through Typert Remote. The shared client reflects which components are available, and DSH Plugin Manager enables or disables each plugin entry separately. Dependencies are explicit. For example, commenting requires Live, and agent iteration requires commenting and the host's agent service.

The workbench entry owns the DSH UI and Remote endpoints. The Android Runtime entry owns the dedicated distribution, subprocesses, and gateway credentials. Flutter, React Native and native Android each register a separate build adapter. Disabling one adapter removes it from the project picker and leaves the installed app available. Disabling Android leaves the workbench available and stops any runtime it owns. The browser negotiates WebRTC through the Host and sends input through the same DSH stream. Video flows directly from the emulator to the browser over WebRTC.

| Component | Responsibility |
|---|---|
| Layout and text scaffolding | Two independently enabled entry points share one generation workflow. Each layout screen stores block rows, columns and widths on a 12-column grid. Framework starters and the Agent use the same draft. The text entry describes the app directly. |
| Live and commenting | Live forwards mouse and keyboard input to the app. Comment Mode supports component selection, area selection, and comments across screens. Each comment records the frame at the time of annotation, the selection in device coordinates, the source baseline, and any available component location. |
| Agent iteration | Submits comments as one batch and manages the candidate source, validation, patch application, Live handoff, per-comment outcomes, and diff. |
| Framework adapters | Flutter, React Native, and native Android have separate entries for project generation, builds, component inspection, and scene restoration. |
| Platform sessions | Android provides deployment, video, input, screenshots, and logs. iOS and HarmonyOS use the same platform interface. Framework adapters and platform sessions can be combined independently. |

## Project source and sessions

Before generation, the workbench keeps a structured layout draft or text brief. The Host materializes a pinned framework starter in an isolated candidate, including a debug scene bridge. The Agent can edit application sources and supported local assets. Build configuration, dependency locks, and the native scene bridge stay protected. The Host checks the source directory is still empty and publishes files only after the candidate builds, launches, and reports a checkpoint from its new process.

After generation, the Windows project directory is the source of truth. Agent edits produce source patches. A versioned build copy lives on the Linux filesystem and can be recreated with the runtime. The annotated frame and device coordinates give the Agent a target in the running UI.

The project owns comment drafts. App Studio creates dedicated DSH sessions using the project root, so they appear in the session list and use the existing Workspace grouping, pinning, and archiving features. Dedicated sessions receive iteration tasks, with agent writes scoped to the candidate copy. Users can open regular DSH sessions for viewing. A submission keeps the session ID selected at submission time, so switching sessions affects only the next iteration.

The dedicated session belongs to the source Workspace and uses the App Studio preset. A session created for generation can also receive comment iterations. The shared Agent entry grants candidate file tools to the exact submitted DSH turn and masks other tools for that preset. Annotated JPEG frames enter DSH as image attachments. The Host records a batch ID before sending the prompt, tracks its settlement and retains the job and candidate outside the workbench connection. A repair uses the original session and candidate baseline.

## Android runtime and transport

The DSH host starts a dedicated WSL2 distribution through a managed subprocess. First-time setup imports the base image and installs pinned packages after the user accepts the SDK license. Cold startup checks nested virtualization, the KVM device, and access for the non-root runtime user. The distribution disk retains the SDK, system image, virtual devices, and caches. The Host tracks active use separately from individual WebRTC connections. After the last Live or build session ends, a short idle period allows the workbench to reconnect before the Host shuts down the emulators and stops the dedicated distribution. **Uninstall Runtime** removes the dedicated environment. **Reinitialize Runtime** removes it and provisions it again from the version lock.

Two Android virtual devices share the SDK and system image, with separate device data. One serves the current Live viewport while the other prepares the candidate in the background. **Video uses the Android Emulator's native RTC v2 WebRTC stream. Input uses authenticated Emulator Controller gRPC.** Each device has its own discovery file, signaling connection, and input target. Control endpoints are local, with token authentication and a gRPC method allowlist. The host owns the connections and their cleanup. After the host verifies the restored scene, the client opens a fresh connection to the candidate. The old Live device continues to receive input until the candidate connection decodes its first frame and its control channel is ready. The client switches video and input together.

On cold startup, the host uses the last deployment record for this runtime to choose the first physical device. The gateway starts serving it as soon as it is ready. When Live starts from the workbench, the other device starts after the current preview has a decoded frame and input. A build that needs the other device can start it independently. A background startup failure leaves the current preview available. The client keeps the decoded video elements and peers in the plugin session when the workbench unmounts, and reattaches them when the user returns. Leaving the workbench releases any held keys and touch.

Google's Gateway serves as the reference for the RTC adapter. Protocol stubs come from the proto files bundled with the pinned Emulator. The adapter accepts emulator-initiated SDP offers, handles flat JSEP messages, and reads each authentication token from the device's private discovery file. A connection is ready once video has decoded and input is available. During reconnect, the viewport retains the last frame.

App Studio disables automatic stylus handwriting on its two dedicated Android devices at startup. The soft keyboard remains available while desktop keys go directly to the focused field.

## Debug scene interface

The Windows project stays authoritative. The Host sends a source archive over stdin to a staged Linux directory, excluding dependency caches, build outputs and host-local SDK configuration. Flutter, React Native and native Android adapters produce and inspect a standalone debug APK inside WSL. The private Android gateway resolves the ADB serial by AVD identity and deploys to the requested device.

The debug build atomically writes `files/appstudio-scene.json` in its Android app sandbox. It includes the current process ID as `pid`, the installed version code as `nativeVersion`, and app-owned JSON fields for navigation, selection, scroll and draft state. The gateway reads it through `adb run-as`. On cold start, the app consumes and deletes `files/appstudio-resume.json` if present, applies the logical state to the visible UI, and publishes a fresh checkpoint from the new process. The app should publish after restoration settles and after user changes.

Native Android can use `filesDir`, `Process.myPid()` and `PackageInfo.longVersionCode` directly. Flutter can expose those Android operations via a platform channel, and React Native via a native module. Keep the hook in debug builds. Each scene checkpoint is limited to 256 KiB.

The gateway checks that the target package reports the requested installed version and that a newly launched process published the checkpoint. It compares the application fields exactly and excludes the process and version metadata from scene equality. The source app stays running during deployment and the Host checks that the source scene is still current before handoff.

## Submission and scene handoff

1. The user clicks **Submit Iteration**. The host records the comment batch and source baseline. The DSH agent edits the candidate copy while the current Live app keeps running.
2. The candidate builds, launches, and restores the test scene. A debug-only interface exports, restores, and validates navigation, domain objects, scroll anchors, and unsaved input. Generated projects include the interface, and existing projects integrate it to support seamless iterations. The project provides any restoration needed for device-bound sign-ins or external connections.
3. Before handoff, the host checks the scene version and source baseline. If the user continued testing, the candidate restores the latest checkpoint. If outside edits changed the source baseline, the host preserves both the source and candidate and reports the conflict.
4. Once the candidate passes the build, launch, and scene restoration checks, the host applies the validated patch and publishes the target device, diff, and per-comment outcomes. The workbench waits for fresh video and input readiness before switching Live.
5. If the build or scene restoration fails, the previous Live app stays interactive, and the candidate changes and logs remain available in the same session. If the source applies and Live has a connection problem, the workbench reports those outcomes separately and lets the user retry Live with the same build.

## Version baseline

The [version baseline](runtime-lock.json) records the validated combination of DSH, WSL2, Android Emulator, system image, RTC, and test toolchains. Runtime setup verifies the required versions. Upgrade candidates must pass video and input handoff between two devices, plus forced-restart scene restoration for each framework.
