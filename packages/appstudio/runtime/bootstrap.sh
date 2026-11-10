#!/usr/bin/env bash
set -euo pipefail
umask 022

runtime=/opt/appstudio
assets=$runtime/runtime
sdk=$runtime/android-sdk
lock=$assets/runtime-lock.json

if [[ $# != 1 || "$(id -u)" != 0 || "$(cat "$runtime/owner")" != "$1" ]]; then
  echo 'App Studio could not verify the WSL distribution owner.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  acl ca-certificates curl kmod openjdk-17-jre-headless python3-venv unzip \
  libgl1 libegl1 libx11-6 libpulse0 libnss3 libxkbcommon0 libdbus-1-3 \
  libxcb1 libfontconfig1 libx11-xcb1 libxcb-cursor0 libxcomposite1 libxcursor1 \
  libxi6 libxrandr2 libxrender1 libxtst6 libasound2t64 libgbm1 \
  libxkbfile1 libxkbcommon-x11-0 libxdamage1 libxss1

if ! id appstudio >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash appstudio
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
  [[ -x "$1/cmdline-tools/latest/bin/avdmanager" ]]
}

if ! verify_sdk "$sdk" >/dev/null 2>&1; then
  staging=$(mktemp -d "$runtime/sdk-stage.XXXXXXXX")
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
  install -d "$new_sdk/cmdline-tools" "$new_sdk/system-images/android-36/google_apis"

  extract() {
    local archive=$1 digest_tool=$2 digest=$3 destination=$4
    curl --fail --silent --show-error --location --proto '=https' --retry 3 \
      --connect-timeout 30 --output "$staging/package.zip" "https://dl.google.com/android/repository/$archive"
    if ! printf '%s  %s\n' "$digest" "$staging/package.zip" | "$digest_tool" --check --status; then
      echo "The downloaded Android archive does not match its pinned checksum ($archive)." >&2
      return 1
    fi
    unzip -q "$staging/package.zip" -d "$destination"
    rm -- "$staging/package.zip"
  }

  # The emulator, platform tools, and system image digests come from Google's SDK catalogs.
  extract "commandlinetools-linux-$cli_build"_latest.zip sha256sum "$cli_hash" "$new_sdk/cmdline-tools"
  mv "$new_sdk/cmdline-tools/cmdline-tools" "$new_sdk/cmdline-tools/latest"
  extract "emulator-linux_x64-$emulator_build.zip" sha1sum f41f9e31eb5ca64926603c03265c50bbc0ff4172 "$new_sdk"
  extract "platform-tools_r$adb_pin-linux.zip" sha1sum 477254aa5f903c15cf51001717bdf347fb6b53e0 "$new_sdk"
  printf -v revision '%02d' "$image_revision"
  extract "sys-img/google_apis/x86_64-36_r$revision.zip" sha1sum c6bf44bdcd885bb902b4ba752d111a073ad7a817 \
    "$new_sdk/system-images/android-36/google_apis"
  verify_sdk "$new_sdk"
  emulator_version=$("$new_sdk/emulator/emulator" -version 2>&1)
  if [[ "$emulator_version" != *"version $emulator_pin."* && "$emulator_version" != *"version $emulator_pin ("* ]] ||
    ! grep -Fq "(build_id $emulator_build)" <<< "$emulator_version"; then
    echo 'The emulator executable does not match the App Studio runtime lock.' >&2
    exit 1
  fi
  adb_version=$("$new_sdk/platform-tools/adb" version)
  if ! grep -Fxq "Version $adb_pin-$adb_build" <<< "$adb_version"; then
    echo 'The adb executable does not match the App Studio runtime lock.' >&2
    exit 1
  fi

  if [[ -e "$sdk" ]]; then
    mv "$sdk" "$staging/previous-sdk"
  fi
  mv "$new_sdk" "$sdk"
  rm -rf -- "$staging"
  trap - EXIT
fi

# These exact packages were provisioned following explicit license consent in the Host.
install -d "$sdk/licenses"
printf '%s\n' 24333f8a63b6825ea9c5514f83c2829b004d1fee > "$sdk/licenses/android-sdk-license"

bash "$assets/install-gateway.sh"
sha256sum "$lock" | cut -d ' ' -f 1 > "$runtime/provisioned.tmp"
mv "$runtime/provisioned.tmp" "$runtime/provisioned"
