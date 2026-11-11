#!/usr/bin/env bash
set -euo pipefail
umask 022

runtime=/opt/appstudio
assets=$runtime/runtime
sdk=$runtime/android-sdk
lock=$assets/runtime-lock.json

if [[ $# != 1 || "$EUID" != 0 || ! -f "$runtime/owner" || "$(cat "$runtime/owner")" != "$1" ]]; then
  echo 'App Studio could not verify the WSL distribution owner.' >&2
  exit 1
fi

runtime_error() {
  printf '%s\nAPPSTUDIO_RUNTIME_ERROR %s\n' "$2" "$1" >&2
  exit 1
}

# Fail before large downloads when the guest cannot run the pinned Android image.
bash "$assets/start.sh" --preflight "$1"

export DEBIAN_FRONTEND=noninteractive
packages=(
  acl ca-certificates curl kmod openjdk-17-jre-headless python3-venv unzip \
  libgl1 libegl1 libx11-6 libpulse0 libnss3 libxkbcommon0 libdbus-1-3 \
  libxcb1 libfontconfig1 libx11-xcb1 libxcb-cursor0 libxcomposite1 libxcursor1 \
  libxi6 libxrandr2 libxrender1 libxtst6 libasound2t64 libgbm1 \
  libxkbfile1 libxkbcommon-x11-0 libxdamage1 libxss1
)
missing=()
for package in "${packages[@]}"; do
  if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null)" != installed ]]; then
    missing+=("$package")
  fi
done
if (( ${#missing[@]} )); then
  if ! apt-get -o APT::Update::Error-Mode=any update -qq >/dev/null 2>&1; then
    runtime_error linux-dependencies 'Could not fetch Ubuntu package indexes. Check DNS, proxy, or network access from WSL, then retry initialization.'
  fi
  if ! apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null 2>&1; then
    runtime_error linux-dependencies 'Could not install the Linux runtime dependencies. Check WSL network access and free space, then retry initialization.'
  fi
fi
bash "$assets/start.sh" --preflight "$1"

if ! id appstudio >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash appstudio ||
    runtime_error gateway-dependencies 'Could not create the App Studio runtime user.'
fi

cat > /etc/wsl.conf <<'CONF'
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
[user]
default=appstudio
CONF

verify_sdk() {
  python3 - "$lock" "$1" <<'PY' || return
import json
import pathlib
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text())
android = lock["android"]
sdk = pathlib.Path(sys.argv[2])
image = android["systemImage"]
package = image["sdkPackage"].split(";")
if package != ["system-images", "android-36", "google_apis", "x86_64"]:
    raise SystemExit("The Android system image in the runtime lock is unsupported.")

def verify_properties(path, expected):
    if not path.is_file():
        raise SystemExit(f"Android package properties are missing: {path}")
    properties = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition("=")
        if separator:
            properties[key.strip()] = value.strip()
    for key, value in expected.items():
        if properties.get(key) != str(value):
            raise SystemExit(f"Unexpected {key} in Android package {path.parent.name}.")

verify_properties(sdk / "emulator/source.properties", {
    "Pkg.Revision": android["emulator"]["version"],
    "Pkg.BuildId": android["emulator"]["buildId"],
})
verify_properties(sdk / "platform-tools/source.properties", {
    "Pkg.Revision": android["platformTools"]["version"],
})
verify_properties(sdk.joinpath(*package, "source.properties"), {
    "AndroidVersion.ApiLevel": "36",
    "AndroidVersion.ExtensionLevel": image["extensionLevel"],
    "Pkg.Revision": image["revision"],
    "SystemImage.Abi": package[3],
    "SystemImage.TagId": package[2],
})
if not sdk.joinpath(*package, "system.img").is_file():
    raise SystemExit("Android system image is missing.")
PY
  [[ -x "$1/cmdline-tools/latest/bin/avdmanager" && -x "$1/cmdline-tools/latest/bin/sdkmanager" &&
    -x "$1/emulator/emulator" && -x "$1/platform-tools/adb" &&
    -r "$1/emulator/lib/emulator_controller.proto" && -r "$1/emulator/lib/rtc_service_v2.proto" ]]
}

if ! verify_sdk "$sdk" >/dev/null 2>&1; then
  staging=$(mktemp -d "$runtime/sdk-stage.XXXXXXXX") ||
    runtime_error runtime-storage 'Could not stage the Android SDK. Check free space and write access to the dedicated WSL distribution.'
  trap 'rm -rf -- "$staging"' EXIT
  pin_line=$(python3 - "$lock" <<'PY'
import json
import pathlib
import sys

android = json.loads(pathlib.Path(sys.argv[1]).read_text())["android"]
print(
    android["commandLineToolsBuild"],
    android["commandLineToolsLinuxSha256"],
    android["emulator"]["buildId"],
    android["emulator"]["version"],
    android["platformTools"]["version"],
    android["platformTools"]["buildId"],
    android["systemImage"]["revision"],
)
PY
)
  read -r cli_build cli_hash emulator_build emulator_pin adb_pin adb_build image_revision <<< "$pin_line"
  new_sdk=$staging/sdk
  install -d "$new_sdk/cmdline-tools" "$new_sdk/system-images/android-36/google_apis" ||
    runtime_error runtime-storage 'Could not create the Android SDK staging directories.'

  extract() {
    local archive=$1 digest_tool=$2 digest=$3 destination=$4 status
    curl --fail --silent --location --proto '=https' --retry 3 \
      --connect-timeout 30 --output "$staging/package.zip" "https://dl.google.com/android/repository/$archive" || {
        status=$?
        if [[ "$status" == 23 ]]; then
          runtime_error runtime-storage 'Could not write the downloaded Android archive. Check WSL free space and permissions.'
        fi
        runtime_error sdk-download "Could not download the pinned Android archive ($archive, curl exit $status). Check dl.google.com access from WSL, proxy and TLS settings, then retry initialization."
      }
    if ! printf '%s  %s\n' "$digest" "$staging/package.zip" | "$digest_tool" --check --status; then
      runtime_error sdk-invalid "The downloaded Android archive failed its pinned checksum ($archive). Retry initialization over a trusted connection."
    fi
    unzip -q "$staging/package.zip" -d "$destination" >/dev/null 2>&1 ||
      runtime_error runtime-storage "Could not unpack the verified Android archive ($archive). Check free space in the dedicated WSL distribution."
    rm -- "$staging/package.zip"
  }

  # The emulator, platform tools, and system image digests come from Google's SDK catalogs.
  extract "commandlinetools-linux-$cli_build"_latest.zip sha256sum "$cli_hash" "$new_sdk/cmdline-tools"
  mv "$new_sdk/cmdline-tools/cmdline-tools" "$new_sdk/cmdline-tools/latest" ||
    runtime_error sdk-invalid 'The Android command-line tools archive did not contain the expected layout.'
  extract "emulator-linux_x64-$emulator_build.zip" sha1sum f41f9e31eb5ca64926603c03265c50bbc0ff4172 "$new_sdk"
  extract "platform-tools_r$adb_pin-linux.zip" sha1sum 477254aa5f903c15cf51001717bdf347fb6b53e0 "$new_sdk"
  printf -v revision '%02d' "$image_revision"
  extract "sys-img/google_apis/x86_64-36_r$revision.zip" sha1sum c6bf44bdcd885bb902b4ba752d111a073ad7a817 \
    "$new_sdk/system-images/android-36/google_apis"
  verify_sdk "$new_sdk" ||
    runtime_error sdk-invalid 'The staged Android SDK did not match the pinned versions and files.'
  emulator_version=$("$new_sdk/emulator/emulator" -version 2>&1) ||
    runtime_error sdk-invalid 'The staged Android emulator could not run. Check the Linux runtime dependencies and retry initialization.'
  if [[ "$emulator_version" != *"version $emulator_pin."* && "$emulator_version" != *"version $emulator_pin ("* ]] ||
    ! grep -Fq "(build_id $emulator_build)" <<< "$emulator_version"; then
    runtime_error sdk-invalid 'The emulator executable does not match the App Studio runtime lock.'
  fi
  adb_version=$("$new_sdk/platform-tools/adb" version 2>&1) ||
    runtime_error sdk-invalid 'The staged Android platform tools could not run.'
  if ! grep -Fxq "Version $adb_pin-$adb_build" <<< "$adb_version"; then
    runtime_error sdk-invalid 'The adb executable does not match the App Studio runtime lock.'
  fi

  if [[ -e "$sdk" ]]; then
    mv "$sdk" "$staging/previous-sdk" ||
      runtime_error runtime-storage 'Could not move the previous Android SDK aside. Check WSL storage permissions.'
  fi
  if ! mv "$new_sdk" "$sdk"; then
    if [[ -d "$staging/previous-sdk" ]] && ! mv "$staging/previous-sdk" "$sdk"; then
      trap - EXIT
      runtime_error runtime-storage 'Could not replace the Android SDK. The previous SDK is retained in the staging directory.'
    fi
    runtime_error runtime-storage 'Could not replace the Android SDK. Check WSL free space and permissions, then retry.'
  fi
  rm -rf -- "$staging"
  trap - EXIT
fi

bash "$assets/sdk-metadata.sh" "$sdk" ||
  runtime_error sdk-invalid 'The Android SDK package metadata could not be created. Retry initialization.'

# These exact packages were provisioned following explicit license consent in the Host.
install -d "$sdk/licenses"
printf '%s\n' 24333f8a63b6825ea9c5514f83c2829b004d1fee > "$sdk/licenses/android-sdk-license"

bash "$assets/install-gateway.sh"
sha256sum "$lock" | cut -d ' ' -f 1 > "$runtime/provisioned.tmp"
mv "$runtime/provisioned.tmp" "$runtime/provisioned"
