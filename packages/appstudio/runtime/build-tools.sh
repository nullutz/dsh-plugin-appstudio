#!/usr/bin/env bash
set -euo pipefail
umask 022

root=/opt/appstudio
sdk=$root/android-sdk
tools=$root/build-tools
java=/usr/lib/jvm/java-21-openjdk-amd64
lock=$root/runtime/build-tools-lock.json

if [[ "$EUID" != 0 || "$#" != 2 || ! -f "$root/owner" || "$(cat "$root/owner")" != "$1" ]]; then
  echo 'App Studio could not verify the WSL distribution owner.' >&2
  exit 1
fi
case "$2" in
  android|flutter|react-native) framework=$2 ;;
  *) echo 'Unknown Android framework.' >&2; exit 1 ;;
esac

runtime_error() {
  printf '%s\nAPPSTUDIO_RUNTIME_ERROR %s\n' "$2" "$1" >&2
  exit 1
}

install -d -m 0755 "$tools" ||
  runtime_error runtime-storage 'Could not create the Android build-tool directory. Check free space and write access in WSL.'
exec 9>"$tools/install.lock"
flock -x 9
install -d -m 0700 -o appstudio -g appstudio "$tools/cache"

packages=()
if [[ ! -x "$java/bin/javac" ]] || ! command -v git >/dev/null || ! command -v xz >/dev/null; then
  packages+=(openjdk-21-jdk-headless git xz-utils)
fi
if [[ "$framework" == flutter ]] &&
  { ! command -v zip >/dev/null || [[ ! -r /usr/lib/x86_64-linux-gnu/libGLU.so.1 ]]; }; then
  packages+=(zip libglu1-mesa)
fi
if (( ${#packages[@]} )); then
  export DEBIAN_FRONTEND=noninteractive
  if ! apt-get -o APT::Update::Error-Mode=any update -qq >/dev/null 2>&1 ||
      ! apt-get install -y -qq --no-install-recommends "${packages[@]}" >/dev/null 2>&1; then
    runtime_error build-dependencies 'Could not install the Linux build tools. Check Ubuntu package access and free space from WSL, then retry the build.'
  fi
fi
export JAVA_HOME=$java ANDROID_HOME=$sdk ANDROID_SDK_ROOT=$sdk
export PATH="$JAVA_HOME/bin:$PATH"

readarray -t pins < <(python3 - "$lock" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as source:
    lock = json.load(source)
    for tool in ('flutter', 'node'):
        print(lock[tool]['version'])
        print(lock[tool]['sha256'])
    android = lock['android']
    print(*android['platforms'], *android['buildTools'], android['ndk'], android['cmake'], sep='\n')
PY
)
if [[ "${#pins[@]}" != 10 ]]; then
  runtime_error build-dependencies 'App Studio Android build toolchain pins are incomplete. Refresh the plugin installation.'
fi

missing=()
required_files=()
need() {
  required_files+=("$1")
  if [[ ! -f "$1" ]]; then missing+=("$2"); fi
}
need "$sdk/platforms/android-${pins[4]}/android.jar" "platforms;android-${pins[4]}"
need "$sdk/build-tools/${pins[6]}/aapt" "build-tools;${pins[6]}"
if [[ "$framework" != android ]]; then
  need "$sdk/ndk/${pins[8]}/source.properties" "ndk;${pins[8]}"
fi
if [[ "$framework" == react-native ]]; then
  need "$sdk/platforms/android-${pins[5]}/android.jar" "platforms;android-${pins[5]}"
  need "$sdk/build-tools/${pins[7]}/aapt" "build-tools;${pins[7]}"
  need "$sdk/cmake/${pins[9]}/bin/cmake" "cmake;${pins[9]}"
fi
if (( ${#missing[@]} )); then
  "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" --install "${missing[@]}" >/dev/null 2>&1 ||
    runtime_error build-dependencies 'Could not install the pinned Android build packages. Check dl.google.com access and free space in WSL, then retry the build.'
fi
for file in "${required_files[@]}"; do
  if [[ ! -r "$file" ]]; then
    runtime_error build-dependencies "An expected Android build tool is missing (${file##*/}). Retry installation of the runtime build tools."
  fi
done

install_tool() (
  local name=$1 url=$2 checksum=$3
  local target="$tools/$name"
  if [[ -x "$target/bin/$name" && -f "$target/.appstudio-archive" && "$(cat "$target/.appstudio-archive")" == "$checksum" ]]; then
    return
  fi
  local staging status
  staging=$(mktemp -d "$tools/.stage.XXXXXXXX") ||
    runtime_error runtime-storage "Could not stage the pinned $name tool. Check WSL storage."
  trap 'rm -rf -- "$staging"' EXIT
  curl --fail --silent --location --proto '=https' --retry 3 --connect-timeout 30 \
    --output "$staging/archive.tar.xz" "$url" || {
      status=$?
      if [[ "$status" == 23 ]]; then
        runtime_error runtime-storage "Could not write the downloaded $name archive. Check WSL free space."
      fi
      runtime_error build-dependencies "Could not download the pinned $name tool (curl exit $status). Check HTTPS access from WSL, then retry the build."
    }
  if ! printf '%s  %s\n' "$checksum" "$staging/archive.tar.xz" | sha256sum --check --status; then
    runtime_error build-dependencies "The $name tool archive failed its SHA-256 check. Retry the build over a trusted connection."
  fi
  install -d "$staging/tool" || exit 1
  tar --extract --xz --file "$staging/archive.tar.xz" --directory "$staging/tool" --strip-components=1 \
    --no-same-owner --no-same-permissions ||
      runtime_error runtime-storage "Could not unpack the verified $name tool. Check WSL free space."
  if [[ ! -x "$staging/tool/bin/$name" ]]; then
    runtime_error build-dependencies "The verified $name tool archive lacks its executable."
  fi
  printf '%s\n' "$checksum" > "$staging/tool/.appstudio-archive" || exit 1
  if [[ "$name" == flutter ]]; then
    install -d -m 0755 "$staging/tool/bin/cache" || exit 1
  fi
  if [[ -e "$target" ]]; then mv -- "$target" "$staging/old-tool" || exit 1; fi
  if ! mv -- "$staging/tool" "$target"; then
    if [[ -e "$staging/old-tool" ]]; then mv -- "$staging/old-tool" "$target"; fi
    exit 1
  fi
)

if [[ "$framework" == flutter ]]; then
  install_tool flutter \
    "https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_${pins[0]}-stable.tar.xz" "${pins[1]}"
  # Flutter may regenerate the tools snapshot, and Gradle builds its included plugin in place.
  if [[ "$(stat -c %U "$tools/flutter/bin/cache")" != appstudio ||
        "$(stat -c %U "$tools/flutter/packages/flutter_tools")" != appstudio ]]; then
    chown -hR appstudio:appstudio "$tools/flutter/bin/cache" "$tools/flutter/packages/flutter_tools"
  fi
elif [[ "$framework" == react-native ]]; then
  install_tool node "https://nodejs.org/dist/v${pins[2]}/node-v${pins[2]}-linux-x64.tar.xz" "${pins[3]}"
fi
