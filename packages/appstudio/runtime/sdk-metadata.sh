#!/usr/bin/env bash
set -euo pipefail
umask 022

sdk=$1
emulator="$sdk/emulator"
platform_tools="$sdk/platform-tools"
image="$sdk/system-images/android-36/google_apis/x86_64"

# The pinned archives are unpacked directly. Android's local package scanner
# can import the image and platform tools, but does not import the emulator.
if [[ ! -s "$emulator/package.xml" ]]; then
  revision=$(sed -n 's/^Pkg\.Revision=//p' "$emulator/source.properties")
  if [[ ! "$revision" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo 'The Android emulator package revision is missing or invalid.' >&2
    exit 1
  fi
  temporary=$(mktemp "$emulator/package.xml.XXXXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  cat > "$temporary" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<repo:repository xmlns:repo="http://schemas.android.com/repository/android/common/02"
                 xmlns:generic="http://schemas.android.com/repository/android/generic/02"
                 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <localPackage path="emulator" obsolete="false">
    <type-details xsi:type="generic:genericDetailsType" />
    <revision><major>${BASH_REMATCH[1]}</major><minor>${BASH_REMATCH[2]}</minor><micro>${BASH_REMATCH[3]}</micro></revision>
    <display-name>Android Emulator</display-name>
  </localPackage>
</repo:repository>
XML
  chmod 0644 "$temporary"
  mv -fT -- "$temporary" "$emulator/package.xml"
fi

if [[ ! -s "$platform_tools/package.xml" || ! -s "$image/package.xml" ]]; then
  # Listing installed packages lets sdkmanager persist its legacy imports
  # while the SDK is writable by root, without fetching or updating packages.
  if ! output=$(timeout 30 "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" --list_installed 2>&1); then
    echo 'Could not index the installed Android SDK packages.' >&2
    printf '%s\n' "${output: -800}" >&2
    exit 1
  fi
  if [[ ! -s "$platform_tools/package.xml" || ! -s "$image/package.xml" ]]; then
    echo 'Android SDK package metadata is incomplete after indexing.' >&2
    exit 1
  fi
fi
