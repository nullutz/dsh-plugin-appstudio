#!/usr/bin/env bash
set -euo pipefail

runtime=/opt/appstudio/runtime
sdk=/opt/appstudio/android-sdk
state=/opt/appstudio/gateway
[[ "$EUID" == 0 ]] || { echo 'Gateway installation requires root.' >&2; exit 1; }

readarray -t pins < <(python3 - "$runtime/runtime-lock.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding='utf-8') as source:
    lock = json.load(source)['rtc']
for package in ('aiohttp', 'grpcio', 'protobuf'):
    print(lock[package])
PY
)
[[ "${#pins[@]}" == 3 ]] || { echo 'Missing gateway dependency pins.' >&2; exit 1; }

install -d -m 700 -o appstudio -g appstudio "$state" "$state/proto" "$state/state"
runuser -u appstudio -- python3 -m venv "$state/python" "$state/protoc"
python="$state/python/bin/python"
protoc="$state/protoc/bin/python"
runuser -u appstudio -- "$python" -m pip install --disable-pip-version-check --no-input \
  "aiohttp==${pins[0]}" "grpcio==${pins[1]}" "protobuf==${pins[2]}"
runuser -u appstudio -- "$protoc" -m pip install --disable-pip-version-check --no-input \
  "grpcio-tools==${pins[1]}"

includes=$(runuser -u appstudio -- "$protoc" -c 'from pathlib import Path; import grpc_tools; print(Path(grpc_tools.__file__).with_name("_proto"))')
runuser -u appstudio -- "$protoc" -m grpc_tools.protoc \
  -I "$sdk/emulator/lib" -I "$includes" \
  --python_out="$state/proto" --grpc_python_out="$state/proto" \
  emulator_controller.proto ice_config.proto rtc_service_v2.proto
runuser -u appstudio -- "$python" -m pip check
runuser -u appstudio -- env "PYTHONPATH=$state/proto" "$python" -B -c \
  'import aiohttp, emulator_controller_pb2_grpc, rtc_service_v2_pb2_grpc'
