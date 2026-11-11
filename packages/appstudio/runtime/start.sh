#!/usr/bin/env bash
set -euo pipefail

root=/opt/appstudio
runtime="$root/runtime"
state="$root/gateway"
mode=start
case "${1:-}" in
  --stop) mode=stop; shift ;;
  --preflight) mode=preflight; shift ;;
esac
if [[ "$EUID" != 0 || "$#" -lt 1 || "$#" -gt 3 || -z "$1" || ! -f "$root/owner" || "$(cat "$root/owner")" != "$1" ]]; then
  echo 'App Studio runtime ownership could not be verified.' >&2
  exit 1
fi

runtime_error() {
  printf '%s\nAPPSTUDIO_RUNTIME_ERROR %s\n' "$2" "$1" >&2
  exit 1
}

check_virtualization() {
  if [[ "$(uname -m)" != x86_64 ]]; then
    runtime_error guest-architecture 'App Studio uses an x86-64 Android system image and requires an x86-64 WSL 2 guest.'
  fi
  [[ ! -c /dev/kvm ]] || return 0
  local module
  if grep -qw svm /proc/cpuinfo; then
    module=kvm_amd
  elif grep -qw vmx /proc/cpuinfo; then
    module=kvm_intel
  else
    runtime_error kvm-unavailable 'The WSL 2 guest cannot see CPU virtualization extensions. Enable firmware virtualization and WSL 2 nested virtualization, then restart WSL.'
  fi
  if [[ "$mode" == preflight ]] && ! command -v modprobe >/dev/null; then
    # A new Ubuntu base image installs kmod during provisioning.
    return 0
  fi
  timeout 10 modprobe "$module" >/dev/null 2>&1 || true
  if [[ ! -c /dev/kvm ]]; then
    runtime_error kvm-unavailable 'WSL 2 could not load its KVM accelerator. Check nested virtualization and the WSL kernel, then restart WSL.'
  fi
}

command=(runuser -u appstudio -- env "PYTHONPATH=$state/proto" "$state/python/bin/python" -B "$runtime/gateway.py")
if [[ "$mode" == stop ]]; then
  if [[ "$#" != 1 ]]; then
    echo 'Stopping App Studio requires the runtime owner only.' >&2
    exit 1
  fi
  if [[ -S "$state/state/control.sock" ]]; then
    exec "${command[@]}" --stop
  fi
  exit 0
fi
if [[ "$mode" == preflight ]]; then
  if [[ "$#" != 1 ]]; then
    echo 'Checking App Studio requires the runtime owner only.' >&2
    exit 1
  fi
  check_virtualization
  exit 0
fi
arguments=()
if [[ "$#" -ge 2 ]]; then
  case "$2" in
    live|candidate) arguments+=("$2") ;;
    *) echo 'App Studio received an invalid primary Android device role.' >&2; exit 1 ;;
  esac
fi
if [[ "$#" == 3 ]]; then
  if [[ "$3" != after-preview ]]; then
    echo 'App Studio received an invalid background startup mode.' >&2
    exit 1
  fi
  arguments+=("$3")
fi

sha=$(sha256sum "$runtime/runtime-lock.json") ||
  runtime_error sdk-invalid 'The App Studio runtime lock could not be read. Refresh the plugin installation.'
if [[ ! -f "$root/provisioned" || "$(cat "$root/provisioned")" != "${sha%% *}" ]]; then
  runtime_error sdk-invalid 'App Studio needs to be initialized using the current runtime lock.'
fi

check_virtualization
if ! id appstudio >/dev/null 2>&1 || [[ ! -x "$state/python/bin/python" || ! -r "$runtime/gateway.py" ]] ||
    ! runuser -u appstudio -- "$state/python/bin/python" -IB -c \
      'import sys; sys.path.insert(0, sys.argv[1]); import aiohttp, emulator_controller_pb2_grpc, rtc_service_v2_pb2_grpc' \
      "$state/proto" >/dev/null 2>&1; then
  runtime_error gateway-dependencies 'The App Studio gateway dependencies are missing or unusable. Initialize the runtime again to repair them.'
fi
bash "$runtime/sdk-metadata.sh" "$root/android-sdk" ||
  runtime_error sdk-invalid 'The installed Android SDK metadata could not be verified. Initialize the runtime again to repair it.'

if ! runuser -u appstudio -- test -r /dev/kvm || ! runuser -u appstudio -- test -w /dev/kvm; then
  if ! setfacl -m u:appstudio:rw /dev/kvm >/dev/null 2>&1 ||
      ! runuser -u appstudio -- test -r /dev/kvm || ! runuser -u appstudio -- test -w /dev/kvm; then
    runtime_error kvm-unavailable 'The App Studio runtime user cannot access /dev/kvm. Check the WSL kernel and permissions, then restart WSL.'
  fi
fi
exec "${command[@]}" "${arguments[@]}"
