# App Studio Android starter templates

The templates are distributed with the plugin. They produce standalone debug APK projects without accessing a validation workspace. The native `SceneStore.java` is shared across templates and is gated by Android's debuggable application flag.

The Gradle wrapper files and license in `common/` come from the official [Gradle v9.4.1 tag](https://github.com/gradle/gradle/tree/v9.4.1). The wrapper JAR's SHA-256 is `55243ef57851f12b070ad14f7f5bb8302daceeebc5bce5ece5fa6edb23e1145c`. Distribution checksums come from the [official Gradle checksum table](https://gradle.org/release-checksums/). The Flutter and native templates use the pinned Gradle 9.3.1 distribution. React Native uses its 0.88.1 dependency lock and Gradle 9.4.1.
