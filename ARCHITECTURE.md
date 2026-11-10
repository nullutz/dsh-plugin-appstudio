# DSH App Studio Architecture

English | [简体中文](ARCHITECTURE.zh.md)

App Studio makes the running app the entry point for an agent-driven iteration. The user supplies a selection and an intent, the agent edits project source, and the workbench validates the candidate and restores the current test scene. The first release runs Android apps on Windows and covers Flutter, React Native, and native Android. iOS and HarmonyOS extend the same platform session interface.

## Plugin components

App Studio ships as one Cordis bundle. The React and TypeScript client mounts the workbench in DSH's sidebar navigation and main panel slots. It calls the TypeScript host through Typert Remote. The shared client reflects which components are available, and DSH Plugin Manager enables or disables each plugin entry separately. Dependencies are explicit. For example, commenting requires Live, and agent iteration requires commenting and the host's agent service.

| Component | Responsibility |
|---|---|
| Layout and text scaffolding | Two entry points share the same project generation request. The layout draft describes the page hierarchy and intent, and the agent generates buildable source for the selected framework. |
| Live and commenting | Live forwards mouse and keyboard input to the app. Comment Mode supports component selection, area selection, and comments across screens. Each comment records the frame at the time of annotation, the selection in device coordinates, the source baseline, and any available component location. |
| Agent iteration | Submits comments as one batch and manages the candidate source, validation, patch application, Live handoff, per-comment outcomes, and diff. |
| Framework adapters | Flutter, React Native, and native Android have separate entries for project generation, builds, component inspection, and scene restoration. |
| Platform sessions | Android provides deployment, video, input, screenshots, and logs. iOS and HarmonyOS use the same platform interface. Framework adapters and platform sessions can be combined independently. |

## Project source and sessions

Before generation, a structured draft captures layout and page intent. After generation, the Windows project directory is the source of truth. Both agent edits and visual edits produce source patches. A versioned build copy lives on the Linux filesystem and can be recreated with the runtime. Framework adapters provide component locations. When a precise location is unavailable, the annotated frame and selection still give the agent a target.

The project owns comment drafts. App Studio creates dedicated DSH sessions using the project root, so they appear in the session list and use the existing Workspace grouping, pinning, and archiving features. Dedicated sessions receive iteration tasks, with agent writes scoped to the candidate copy. Users can open regular DSH sessions for viewing. A submission keeps the session ID selected at submission time, so switching sessions affects only the next iteration.

## Android runtime and transport

The DSH host starts a dedicated WSL2 distribution through a managed subprocess. First-time setup imports the base image and installs pinned packages after the user accepts the SDK license. Cold startup checks nested virtualization, the KVM device, and access for the non-root runtime user. The distribution disk retains the SDK, system image, virtual devices, and caches. After the last Live or build session ends, the host shuts down the emulators and stops the dedicated distribution. **Uninstall Runtime** removes the dedicated environment. **Reinitialize Runtime** removes it and provisions it again from the version lock.

Two Android virtual devices share the SDK and system image, with separate device data. One serves the current Live viewport while the other prepares the candidate in the background. **Video uses the Android Emulator's native RTC v2 WebRTC stream. Input uses authenticated Emulator Controller gRPC.** Each device has its own discovery file, signaling connection, and input target. Control endpoints are local, with token authentication and a gRPC method allowlist. The host owns the connections and their cleanup. The client switches video and input together once it can display a candidate frame and the control channel is ready.

Google's Gateway serves as the reference for the RTC adapter. Protocol stubs come from the proto files bundled with the pinned Emulator. The adapter accepts emulator-initiated SDP offers, handles flat JSEP messages, and reads each authentication token from the device's private discovery file. A connection is ready once video has decoded and input is available. During reconnect, the viewport retains the last frame and requests a redraw when the scene is static.

## Submission and scene handoff

1. The user clicks **Submit Iteration**. The host records the comment batch and source baseline. The DSH agent edits the candidate copy while the current Live app keeps running.
2. The candidate builds, launches, and restores the test scene. A debug-only interface exports, restores, and validates navigation, domain objects, scroll anchors, and unsaved input. Generated projects include the interface, and existing projects integrate it to support seamless iterations. The project provides any restoration needed for device-bound sign-ins or external connections.
3. Before handoff, the host checks the scene version and source baseline. If the user continued testing, the candidate restores the latest checkpoint. If outside edits changed the source baseline, the host revalidates after merging and surfaces conflicts for the user.
4. Once the candidate passes the build, launch, scene restoration, video, and input checks, the host applies the validated patch, switches Live, and shows the diff and per-comment outcomes. It retains the previous device until handoff is confirmed.
5. If the build or scene restoration fails, the previous Live app stays interactive, and the candidate changes and logs remain available in the same session. If the source applies and Live has a connection problem, the workbench reports those outcomes separately and lets the user retry Live with the same build.

## Version baseline

The [version baseline](runtime-lock.json) records the validated combination of DSH, WSL2, Android Emulator, system image, RTC, and test toolchains. Runtime setup verifies the required versions. Upgrade candidates must pass video and input handoff between two devices, plus forced-restart scene restoration for each framework.
