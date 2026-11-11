#!/usr/bin/env bash
set -euo pipefail

runtime=/opt/appstudio/runtime
sdk=/opt/appstudio/android-sdk
state=/opt/appstudio/gateway
[[ "$EUID" == 0 ]] || { echo 'Gateway installation requires root.' >&2; exit 1; }

runtime_error() {
  printf '%s\nAPPSTUDIO_RUNTIME_ERROR %s\n' "$2" "$1" >&2
  exit 1
}

readarray -t pins < <(python3 - "$runtime/runtime-lock.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as source:
    lock = json.load(source)['rtc']
for package in ('aiohttp', 'grpcio', 'protobuf'):
    print(lock[package])
PY
)
[[ "${#pins[@]}" == 3 ]] ||
  runtime_error gateway-dependencies 'The pinned gateway dependencies are incomplete. Refresh the plugin installation.'

install -d -m 700 -o appstudio -g appstudio "$state" "$state/proto" "$state/state" ||
  runtime_error runtime-storage 'Could not create the gateway directories. Check WSL free space and permissions.'
runuser -u appstudio -- python3 -m venv "$state/python" "$state/protoc" >/dev/null 2>&1 ||
  runtime_error gateway-dependencies 'Could not prepare the Python gateway environment. Check the Linux Python dependencies and WSL free space.'
python="$state/python/bin/python"
protoc="$state/protoc/bin/python"
if ! runuser -u appstudio -- "$python" -m pip install --disable-pip-version-check --no-input \
    "aiohttp==${pins[0]}" "grpcio==${pins[1]}" "protobuf==${pins[2]}" >/dev/null 2>&1 ||
    ! runuser -u appstudio -- "$protoc" -m pip install --disable-pip-version-check --no-input \
    "grpcio-tools==${pins[1]}" >/dev/null 2>&1; then
  runtime_error gateway-dependencies 'Could not install the pinned Python gateway packages. Check Python package index access and free space in WSL, then retry initialization.'
fi

includes=$(runuser -u appstudio -- "$protoc" -c 'from pathlib import Path; import grpc_tools; print(Path(grpc_tools.__file__).with_name("_proto"))') ||
  runtime_error gateway-dependencies 'The pinned gRPC code generator could not be loaded.'
runuser -u appstudio -- "$protoc" -m grpc_tools.protoc \
  -I "$sdk/emulator/lib" -I "$includes" \
  --python_out="$state/proto" --grpc_python_out="$state/proto" \
  emulator_controller.proto ice_config.proto rtc_service_v2.proto >/dev/null 2>&1 ||
  runtime_error gateway-dependencies 'Could not generate the gateway bindings from the pinned Android emulator SDK.'
if ! runuser -u appstudio -- "$python" -m pip check >/dev/null 2>&1 ||
    ! runuser -u appstudio -- env "PYTHONPATH=$state/proto" "$python" -B -c \
    'import aiohttp, emulator_controller_pb2_grpc, rtc_service_v2_pb2_grpc' >/dev/null 2>&1; then
  runtime_error gateway-dependencies 'The installed gateway dependencies failed verification. Retry initialization.'
fi
