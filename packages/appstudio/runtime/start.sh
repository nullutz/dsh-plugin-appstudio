#!/usr/bin/env bash
set -euo pipefail

root=/opt/appstudio
runtime="$root/runtime"
state="$root/gateway"
stop=false
if [[ "${1:-}" == --stop ]]; then
  stop=true
  shift
fi
if [[ "$EUID" != 0 || "$#" != 1 || -z "$1" || ! -f "$root/owner" || "$(cat "$root/owner")" != "$1" ]]; then
  echo 'App Studio runtime ownership could not be verified.' >&2
  exit 1
fi

command=(runuser -u appstudio -- env "PYTHONPATH=$state/proto" "$state/python/bin/python" -B "$runtime/gateway.py")
if "$stop"; then
  if [[ -S "$state/state/control.sock" ]]; then
    exec "${command[@]}" --stop
  fi
  exit 0
fi

sha=$(sha256sum "$runtime/runtime-lock.json")
if [[ ! -f "$root/provisioned" || "$(cat "$root/provisioned")" != "${sha%% *}" ]]; then
  echo 'App Studio runtime needs to be initialized using the current runtime lock.' >&2
  exit 1
fi

if [[ ! -c /dev/kvm ]]; then
  if grep -qw svm /proc/cpuinfo; then
    modprobe kvm_amd
  elif grep -qw vmx /proc/cpuinfo; then
    modprobe kvm_intel
  fi
fi
if [[ ! -c /dev/kvm ]]; then
  echo 'KVM is unavailable inside the App Studio WSL distribution.' >&2
  exit 1
fi
if ! runuser -u appstudio -- test -r /dev/kvm || ! runuser -u appstudio -- test -w /dev/kvm; then
  setfacl -m u:appstudio:rw /dev/kvm
fi
exec "${command[@]}"
