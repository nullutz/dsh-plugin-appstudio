#!/usr/bin/env python3
import asyncio
import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile

from aiohttp import WSCloseCode, WSMsgType, web
from google.protobuf.empty_pb2 import Empty
import grpc

import emulator_controller_pb2 as controller_pb
import emulator_controller_pb2_grpc as controller_rpc
import ice_config_pb2 as ice_pb
import rtc_service_v2_pb2 as rtc_pb
import rtc_service_v2_pb2_grpc as rtc_rpc
from android_scene import AndroidScene, REQUEST_LIMIT, SceneError, parse_scene_request


RUNTIME = Path(__file__).resolve().parent
SDK = Path('/opt/appstudio/android-sdk')
STATE = Path('/opt/appstudio/gateway/state')
CONTROL_SOCKET = STATE / 'control.sock'
ROLES = ('live', 'candidate')
RPC_TIMEOUT = 3
BOOT_TIMEOUT = 240
GPU_PROBE_TIMEOUT = 5
GPU_BOOT_TIMEOUT = 50
DISCOVERY_TIMEOUT = 35
DESKTOP_INPUT_TIMEOUT = 15
SHUTDOWN_TIMEOUT = 8
EMULATOR_LOG_LIMIT = 8192
FRAME_LIMIT = 128 * 1024


class StartupError(Exception):
    def __init__(self, message, code='avd-startup'):
        super().__init__(message)
        self.code = code


class StartupCleanupError(Exception):
    pass


def properties(path):
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        key, found, value = line.partition('=')
        if found:
            values[key.strip()] = value.strip()
    return values


def verify_sdk(lock):
    android = lock['android']
    image = android['systemImage']
    image_path = SDK.joinpath(*image['sdkPackage'].split(';'))
    expected_packages = {
        SDK / 'emulator': {'Pkg.Revision': android['emulator']['version'], 'Pkg.BuildId': android['emulator']['buildId']},
        SDK / 'platform-tools': {'Pkg.Revision': android['platformTools']['version']},
        image_path: {'Pkg.Revision': str(image['revision']), 'AndroidVersion.ExtensionLevel': str(image['extensionLevel'])},
    }
    for folder, expected in expected_packages.items():
        try:
            actual = properties(folder / 'source.properties')
        except (OSError, UnicodeError):
            raise StartupError(f'Android SDK package {folder.name} is unreadable. Initialize the runtime again.', 'sdk-invalid') from None
        if any(actual.get(key) != value for key, value in expected.items()):
            raise StartupError(f'Android SDK package {folder.name} does not match the pinned version. Initialize the runtime again.', 'sdk-invalid')
    if not (image_path / 'system.img').is_file():
        raise StartupError('The pinned Android system image is missing. Initialize the runtime again.', 'sdk-invalid')
    for executable in (SDK / 'emulator/emulator', SDK / 'platform-tools/adb', SDK / 'cmdline-tools/latest/bin/avdmanager'):
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise StartupError(f'The Android SDK executable {executable.name} is unavailable. Initialize the runtime again.', 'sdk-invalid')
    try:
        result = subprocess.run([SDK / 'platform-tools/adb', 'version'], stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        raise StartupError('The Android platform tools could not run in WSL. Initialize the runtime again.', 'sdk-invalid') from None
    if result.returncode or android['platformTools']['buildId'] not in result.stdout:
        raise StartupError('ADB does not match the pinned version. Initialize the runtime again.', 'sdk-invalid')


async def spawn(*arguments, env, stdin=None, capture_output=False):
    return await asyncio.create_subprocess_exec(
        *arguments, env=env, stdin=stdin,
        stdout=asyncio.subprocess.PIPE if capture_output else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.STDOUT if capture_output else asyncio.subprocess.DEVNULL,
        start_new_session=True,
    )


async def stop_process(process):
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), 6)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()


async def accelerated_environment(env):
    wsl_libraries = Path('/usr/lib/wsl/lib')
    if not Path('/dev/dxg').is_char_device() or not wsl_libraries.is_dir():
        return None
    accelerated = {**env, 'GALLIUM_DRIVER': 'd3d12', 'LD_LIBRARY_PATH': str(wsl_libraries)}
    try:
        probe = await spawn(sys.executable, '-IB', RUNTIME / 'gpu_probe.py', env=accelerated)
    except OSError:
        return None
    try:
        return accelerated if await asyncio.wait_for(probe.wait(), GPU_PROBE_TIMEOUT) == 0 else None
    except TimeoutError:
        return None
    finally:
        await stop_process(probe)


def emulator_resources():
    try:
        processors = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        processors = os.cpu_count() or 4
    try:
        pages = os.sysconf('SC_PHYS_PAGES')
        page_size = os.sysconf('SC_PAGE_SIZE')
        total_mb = (pages * page_size) // (1024 * 1024) if pages > 0 and page_size > 0 else 0
    except (AttributeError, OSError, ValueError):
        total_mb = 0
    # Preserve headroom for the second emulator and the WSL guest when the VM has
    # fewer resources than the validation machine. Both AVDs keep the same display.
    return (1 if processors < 4 else 2), (2048 if 0 < total_mb < 7680 else 3072)


def configure_avd(config, width, height):
    cores, memory = emulator_resources()
    settings = {
        'hw.lcd.width': str(width), 'hw.lcd.height': str(height), 'hw.lcd.density': '320',
        'hw.ramSize': str(memory), 'hw.cpu.ncore': str(cores), 'hw.keyboard': 'yes',
    }
    lines = [line for line in config.read_text(encoding='utf-8').splitlines()
             if line.partition('=')[0].strip() not in settings]
    lines.extend(f'{key}={value}' for key, value in settings.items())
    temporary = config.with_suffix('.appstudio.tmp')
    temporary.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    temporary.replace(config)


def emulator_startup_error(message, output):
    # Classify known emulator failures without forwarding arbitrary process output.
    log = output[-EMULATOR_LOG_LIMIT:].decode('utf-8', errors='replace').lower()
    if re.search(r'no space left on device|not enough (?:free )?(?:disk )?space|enospc|disk (?:is )?full', log):
        return StartupError(f'{message} Free space in the dedicated WSL distribution and on its Windows drive.', 'runtime-storage')
    if re.search(r'out of memory|cannot (?:allocate|reserve) memory|not enough (?:physical )?(?:ram|memory)|failed to allocate memory', log):
        return StartupError(f'{message} Increase the WSL 2 memory limit or close other WSL workloads, then retry.', 'guest-resources')
    if re.search(r'(?:kvm|/dev/kvm).{0,80}(?:permission denied|not available|not installed|failed|unusable|disabled)|'
                 r'(?:could not|failed to|cannot|unable to).{0,65}(?:/dev/kvm|\bkvm\b)', log):
        return StartupError(f'{message} Check CPU virtualization and WSL 2 nested virtualization.', 'kvm-unavailable')
    if re.search(r'multiple emulators with the same avd|another emulator instance|avd.{0,80}already (?:running|in use)', log):
        return StartupError(f'{message} Restart the dedicated App Studio runtime to release its virtual device.')
    if re.search(r'invalid package path|system image.{0,65}(?:missing|not found)|broken avd system path', log):
        return StartupError(f'{message} The pinned Android SDK or system image is unavailable. Initialize the runtime again.', 'sdk-invalid')
    return StartupError(f'{message} Check WSL memory, storage, and graphics support before retrying.')


def runtime_failure(error):
    if isinstance(error, StartupError):
        return error
    if isinstance(error, StartupCleanupError):
        return StartupError(str(error))
    if isinstance(error, OSError) and error.errno in (errno.ENOSPC, errno.EDQUOT):
        return StartupError('The dedicated WSL distribution ran out of storage. Free space in WSL and on its Windows drive.', 'runtime-storage')
    if isinstance(error, OSError) and error.errno == errno.ENOMEM:
        return StartupError('WSL could not allocate memory. Increase its memory limit or close other WSL workloads.', 'guest-resources')
    return StartupError('The Android gateway could not finish startup. Check the dedicated WSL runtime and retry.')


def report_runtime_error(error):
    failure = runtime_failure(error)
    print(str(failure), file=sys.stderr, flush=True)
    print(f'APPSTUDIO_RUNTIME_ERROR {failure.code}', file=sys.stderr, flush=True)


class Device:
    def __init__(self, role, lock, env):
        self.role = role
        self.name = f'appstudio_{role}'
        self.android = lock['android']
        self.env = env
        self.width = self.android['emulator']['displayWidth']
        self.height = self.android['emulator']['displayHeight']
        self.process = None
        self.channel = None
        self.controller = None
        self.rtc = None
        self.metadata = None
        self.peer = asyncio.Lock()
        self.log_task = None
        self.log_tail = b''
        self.scene = AndroidScene(self, SDK / 'platform-tools/adb')

    def descriptor(self):
        return {'id': self.role, 'width': self.width, 'height': self.height}

    async def prepare_avd(self):
        config = Path(self.env['ANDROID_AVD_HOME']) / f'{self.name}.avd/config.ini'
        image = self.android['systemImage']['sdkPackage']
        if not config.is_file():
            creation = await spawn(SDK / 'cmdline-tools/latest/bin/avdmanager', 'create', 'avd',
                                   '-n', self.name, '-k', image, '--device', 'pixel', '--force',
                                   env=self.env, stdin=asyncio.subprocess.PIPE, capture_output=True)
            try:
                output, _ = await asyncio.wait_for(creation.communicate(b'no\n'), 90)
            except TimeoutError:
                raise StartupError(f'Creating the {self.role} Android virtual device timed out.') from None
            finally:
                await stop_process(creation)
            if creation.returncode or not config.is_file():
                raise emulator_startup_error(f'Could not create the {self.role} Android virtual device.', output)
        try:
            configured_image = properties(config).get('image.sysdir.1', '').replace('\\', '/').rstrip('/').split('/')
        except (OSError, UnicodeError):
            raise StartupError(f'The {self.role} Android virtual device configuration is unreadable.', 'sdk-invalid') from None
        if configured_image != image.split(';'):
            raise StartupError(f'The {self.role} Android virtual device uses an unexpected system image. Initialize the runtime again.', 'sdk-invalid')
        configure_avd(config, self.width, self.height)

    async def start(self, rendering):
        self.process = await spawn(
            SDK / 'emulator/emulator', '-avd', self.name,
            '-grpc-use-token', '-grpc-allowlist', RUNTIME / 'rtc-allowlist.json',
            '-no-window', '-no-audio', '-no-snapshot', '-gpu', rendering,
            '-accel', 'on', env=self.env, capture_output=True,
        )
        self.log_task = asyncio.create_task(self.read_log())

    async def read_log(self):
        while chunk := await self.process.stdout.read(4096):
            self.log_tail = (self.log_tail + chunk)[-EMULATOR_LOG_LIMIT:]

    async def startup_error(self, message):
        if self.process.returncode is not None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(self.log_task), 0.3)
        return emulator_startup_error(message, self.log_tail)

    def discovery(self):
        folder = Path(self.env['XDG_RUNTIME_DIR']) / 'avd/running'
        pid = self.process.pid
        for name in (f'pid_{pid}.ini', f'pid_{pid}_info.ini'):
            try:
                info = properties(folder / name)
                port = int(info.get('grpc.port', '0'))
            except (FileNotFoundError, ValueError):
                continue
            token = info.get('grpc.token', '')
            if info.get('avd.id') == self.name and 0 < port <= 65535 and token and token.isascii():
                return port, token
        return None

    async def wait_discovery(self):
        # The emulator claims its automatic ports before publishing its private discovery file.
        try:
            async with asyncio.timeout(DISCOVERY_TIMEOUT):
                while self.process.returncode is None:
                    if self.discovery() is not None:
                        return
                    await asyncio.sleep(0.2)
        except TimeoutError:
            raise await self.startup_error(f'The {self.role} Android emulator did not publish its controller in time.') from None
        raise await self.startup_error(
            f'The {self.role} Android emulator exited during startup (code {self.process.returncode}).')

    async def wait_ready(self):
        input_deadline = None
        try:
            async with asyncio.timeout(BOOT_TIMEOUT):
                while self.process.returncode is None:
                    if self.channel is None and (discovery := self.discovery()):
                        port, token = discovery
                        self.channel = grpc.aio.insecure_channel(
                            f'localhost:{port}', options=(('grpc.enable_http_proxy', 0),),
                        )
                        self.controller = controller_rpc.EmulatorControllerStub(self.channel)
                        self.rtc = rtc_rpc.RtcStub(self.channel)
                        self.metadata = (('authorization', f'Bearer {token}'),)
                    if self.controller is not None:
                        try:
                            status = await self.controller.getStatus(Empty(), metadata=self.metadata, timeout=RPC_TIMEOUT)
                            if status.booted:
                                await self.scene.configure_desktop_input()
                                return
                        except SceneError as error:
                            now = asyncio.get_running_loop().time()
                            if input_deadline is None:
                                input_deadline = now + DESKTOP_INPUT_TIMEOUT
                            if now >= input_deadline:
                                raise StartupError(f'Could not configure the {self.role} Android keyboard. {error}') from None
                        except grpc.aio.AioRpcError as error:
                            if error.code() not in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED):
                                raise StartupError(f'The {self.role} Android controller rejected readiness ({error.code().name}).') from None
                    await asyncio.sleep(1)
        except TimeoutError:
            raise await self.startup_error(f'The {self.role} Android device did not boot in time.') from None
        raise await self.startup_error(
            f'The {self.role} Android emulator exited during startup (code {self.process.returncode}).')

    async def close(self):
        try:
            if self.process is not None:
                try:
                    if self.process.returncode is None and self.controller is not None:
                        with contextlib.suppress(TimeoutError):
                            async with asyncio.timeout(SHUTDOWN_TIMEOUT):
                                with contextlib.suppress(grpc.RpcError):
                                    await self.controller.setVmState(controller_pb.VmRunState(state=controller_pb.VmRunState.SHUTDOWN),
                                                                     metadata=self.metadata, timeout=RPC_TIMEOUT)
                                await self.process.wait()
                finally:
                    await stop_process(self.process)
        finally:
            if self.channel is not None:
                await self.channel.close()
            if self.log_task is not None:
                self.log_task.cancel()
                await asyncio.gather(self.log_task, return_exceptions=True)


class InputSession:
    def __init__(self, device):
        self.device = device
        self.touch = None
        self.keys = set()

    async def send_touch(self, x, y, pressure):
        event = controller_pb.TouchEvent(touches=[controller_pb.Touch(x=x, y=y, identifier=1, pressure=pressure)])
        await self.device.controller.sendTouch(event, metadata=self.device.metadata, timeout=RPC_TIMEOUT)

    async def send_key(self, key, action):
        event = controller_pb.KeyboardEvent(key=key, eventType=action)
        await self.device.controller.sendKey(event, metadata=self.device.metadata, timeout=RPC_TIMEOUT)

    async def dispatch(self, event):
        if not isinstance(event, dict):
            raise ValueError('Invalid input event.')
        kind = event.get('kind')
        if kind == 'touch':
            x, y, pressure = (event.get(key) for key in ('x', 'y', 'pressure'))
            width, height = self.device.width, self.device.height
            if (not all(type(value) is int for value in (x, y, pressure)) or pressure not in (0, 1) or
                    not ((0 <= x < width and 0 <= y < height) or (0 <= x < height and 0 <= y < width))):
                raise ValueError('Invalid touch coordinates or pressure.')
            if pressure:
                self.touch = (x, y)
            await self.send_touch(x, y, pressure)
            if not pressure:
                self.touch = None
        elif kind == 'key':
            key, action = event.get('key'), event.get('action')
            if (not isinstance(key, str) or not (1 <= len(key) <= 32) or not key.isascii() or
                    not key.isprintable() or type(action) is not int or action not in (0, 1)):
                raise ValueError('Invalid keyboard event.')
            if action == 0:
                self.keys.add(key)
            await self.send_key(key, action)
            if action == 1:
                self.keys.discard(key)
        else:
            raise ValueError('Unknown input event.')

    async def release(self):
        releases = [self.send_key(key, 1) for key in self.keys]
        if self.touch is not None:
            releases.append(self.send_touch(*self.touch, 0))
        await asyncio.gather(*releases, return_exceptions=True)


def is_answer_or_candidate(frame):
    if frame.get('type') == 'answer':
        return isinstance(frame.get('sdp'), str) and bool(frame['sdp'])
    if 'candidate' not in frame or not isinstance(frame['candidate'], str):
        return False
    mid, index, fragment = (frame.get(key) for key in ('sdpMid', 'sdpMLineIndex', 'usernameFragment'))
    return ((mid is None or isinstance(mid, str)) and
            (index is None or (type(index) is int and index >= 0)) and
            (fragment is None or isinstance(fragment, str)))


async def run_peer(ws, device, preview_ready):
    stream = None
    outgoing = None
    guid = None
    input_session = InputSession(device)

    async def send_to_emulator(frame):
        request = rtc_pb.SendJsepMessageRequest()
        request.jsep_msg.id.guid = guid
        request.jsep_msg.message = json.dumps(frame, separators=(',', ':'))
        await device.rtc.SendJsepMessage(request, metadata=device.metadata, timeout=RPC_TIMEOUT)

    async def forward_emulator():
        try:
            async for response in stream:
                raw = response.jsep_msg.message
                if not raw:
                    break
                frame = json.loads(raw)
                if not isinstance(frame, dict):
                    raise ValueError('Invalid emulator signaling message.')
                await ws.send_json(frame)
        except (grpc.RpcError, ValueError, ConnectionError):
            await ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b'Emulator signaling interrupted')
        else:
            await ws.close()

    try:
        await device.controller.getStatus(Empty(), metadata=device.metadata, timeout=RPC_TIMEOUT)
        request = rtc_pb.RtcStreamRequest(ice_server_config=ice_pb.IceServerConfig())
        response = await device.rtc.RequestRtcStream(request, metadata=device.metadata, timeout=RPC_TIMEOUT)
        guid = response.id.guid
        if not guid:
            raise ValueError('Missing emulator RTC session.')
        await ws.send_json({'appStudioInputReady': True})
        stream = device.rtc.ReceiveJsepMessageStream(rtc_pb.ReceiveJsepMessageRequest(id=rtc_pb.Id(guid=guid)),
                                                     metadata=device.metadata)
        outgoing = asyncio.create_task(forward_emulator())
        async for message in ws:
            if message.type == WSMsgType.ERROR:
                break
            if message.type != WSMsgType.TEXT:
                await ws.close(code=WSCloseCode.UNSUPPORTED_DATA, message=b'Expected JSON text')
                break
            frame = json.loads(message.data)
            if not isinstance(frame, dict):
                raise ValueError('Invalid signaling message.')
            if 'appStudioPreviewReady' in frame:
                if len(frame) != 1 or frame['appStudioPreviewReady'] is not True:
                    raise ValueError('Invalid preview-ready signaling message.')
                if preview_ready is not None:
                    preview_ready.set()
                continue
            if frame.get('bye') is True:
                break
            if 'appStudioInput' in frame:
                try:
                    await input_session.dispatch(frame['appStudioInput'])
                    await ws.send_json({'appStudioInputAck': True})
                except ValueError as error:
                    await ws.send_json({'appStudioInputError': str(error)})
                except grpc.RpcError:
                    await ws.send_json({'appStudioInputError': 'Emulator input could not be delivered.'})
            elif is_answer_or_candidate(frame):
                await send_to_emulator(frame)
            else:
                raise ValueError('Unknown signaling message.')
    except ValueError:
        await ws.close(code=WSCloseCode.PROTOCOL_ERROR, message=b'Invalid signaling message')
    except grpc.RpcError:
        await ws.close(code=WSCloseCode.INTERNAL_ERROR, message=b'Emulator signaling unavailable')
    except ConnectionError:
        pass
    finally:
        if outgoing is not None:
            outgoing.cancel()
        if stream is not None:
            stream.cancel()
        if outgoing is not None:
            await asyncio.gather(outgoing, return_exceptions=True)
        await input_session.release()
        if guid:
            with contextlib.suppress(grpc.RpcError):
                await send_to_emulator({'bye': True})
        await ws.close()


async def start_gateway(devices, token, primary_role, background_requested):
    active = set()

    def authorize(request):
        authorization = request.headers.get('Authorization', '')
        if not secrets.compare_digest(authorization.encode('utf-8'), f'Bearer {token}'.encode('ascii')):
            raise web.HTTPUnauthorized()

    def authorized_device(request):
        authorize(request)
        role = request.match_info['role']
        if role not in devices:
            raise web.HTTPNotFound()
        return devices[role]

    async def signal_handler(request):
        device = authorized_device(request)
        if device.peer.locked():
            raise web.HTTPConflict()
        async with device.peer:
            ws = web.WebSocketResponse(timeout=2, heartbeat=20, max_msg_size=FRAME_LIMIT, compress=False)
            await ws.prepare(request)
            active.add(ws)
            try:
                preview_ready = background_requested if device.role == primary_role else None
                await run_peer(ws, device, preview_ready)
            finally:
                active.discard(ws)
            return ws

    async def scene_handler(request):
        scene = authorized_device(request).scene
        operation = request.match_info['operation']
        try:
            arguments = parse_scene_request(await request.read(), operation)
            async with scene.lock:
                if operation == 'capture':
                    result = await scene.capture(*arguments)
                elif operation == 'resume':
                    result = await scene.resume(*arguments)
                else:
                    result = await scene.deploy(*arguments)
            return web.json_response(result)
        except SceneError as error:
            return web.json_response({'error': str(error)}, status=error.status)

    async def start_background(request):
        authorize(request)
        if request.can_read_body:
            raise web.HTTPBadRequest()
        background_requested.set()
        return web.Response(status=204)

    async def health(request):
        authorize(request)
        return web.Response(status=204)

    async def close_peers(_app):
        await asyncio.gather(*(ws.close(code=WSCloseCode.GOING_AWAY) for ws in active), return_exceptions=True)

    app = web.Application(client_max_size=REQUEST_LIMIT)
    app.router.add_get('/v1/health', health)
    app.router.add_get('/v1/devices/{role}/signal', signal_handler)
    app.router.add_post('/v1/devices/{role}/{operation:capture|deploy|resume}', scene_handler)
    app.router.add_post('/v1/background/start', start_background)
    app.on_shutdown.append(close_peers)
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=6)
    await runner.setup()
    try:
        await web.TCPSite(runner, '127.0.0.1', 0).start()
        return runner, runner.addresses[0][1]
    except BaseException:
        await runner.cleanup()
        raise


async def stop_supervisor():
    try:
        async with asyncio.timeout(25):
            _, writer = await asyncio.open_unix_connection(CONTROL_SOCKET)
            writer.write(b'stop\n')
            await writer.drain()
            writer.close()
            await writer.wait_closed()
            while CONTROL_SOCKET.exists():
                await asyncio.sleep(0.2)
    except (FileNotFoundError, ConnectionRefusedError):
        return


async def boot_device(role, lock, env, rendering, timeout=None):
    device = Device(role, lock, env)
    try:
        async with asyncio.timeout(timeout):
            await device.start(rendering)
            await device.wait_discovery()
            await device.wait_ready()
            if device.process.returncode is not None:
                raise await device.startup_error(f'The {role} Android emulator exited during startup.')
        return device
    except BaseException as failure:
        try:
            await device.close()
        except Exception:
            if not isinstance(failure, asyncio.CancelledError):
                raise StartupCleanupError(f'Could not close the {role} Android emulator after startup failed.') from None
        raise


async def start_device(role, lock, env, accelerated):
    await Device(role, lock, env).prepare_avd()
    if accelerated is not None:
        try:
            return await boot_device(role, lock, accelerated, 'host', GPU_BOOT_TIMEOUT), True
        except (StartupError, OSError, TimeoutError):
            print(f'Accelerated startup for the {role} Android device failed. Retrying with the pinned renderer.',
                  file=sys.stderr, flush=True)
    return await boot_device(role, lock, env, lock['android']['emulator']['rendering']), False


async def start_secondary(role, lock, env, accelerated, devices):
    device, _ = await start_device(role, lock, env, accelerated)
    devices[role] = device
    return device


async def watch_background(role, lock, env, accelerated, devices, requested):
    await requested.wait()
    try:
        device = await start_secondary(role, lock, env, accelerated, devices)
    except (StartupError, StartupCleanupError, OSError, TimeoutError, ValueError, KeyError) as error:
        failure = runtime_failure(error)
        report_runtime_error(failure)
        print(json.dumps({'event': 'device-error', 'role': role, 'code': failure.code, 'detail': str(failure)[:600]}), flush=True)
        return False
    print(json.dumps({'event': 'device-ready', 'device': device.descriptor()}), flush=True)
    await device.process.wait()
    return True


async def run(lock, stop, env, primary_role, after_preview=False):
    legacy_start = primary_role is None
    primary_role = primary_role or 'live'
    accelerated = await accelerated_environment(env)
    primary, hardware = await start_device(primary_role, lock, env, accelerated)
    background_acceleration = accelerated if hardware else None
    devices = {primary_role: primary}
    background_role = next(role for role in ROLES if role != primary_role)
    background_requested = asyncio.Event()
    if not after_preview:
        background_requested.set()
    runner = None
    waits = []
    try:
        primary_exit = asyncio.create_task(primary.process.wait())
        waits.append(primary_exit)
        if legacy_start:
            # Older hosts pass no role and accept only a single two-device announcement.
            startup = asyncio.create_task(start_secondary(
                background_role, lock, env, background_acceleration, devices,
            ))
            waits.append(startup)
            done, _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
            if primary_exit in done:
                raise StartupError('The current Android emulator exited before both devices were ready.')
            secondary = startup.result()
            waits.remove(startup)
            waits.append(asyncio.create_task(secondary.process.wait()))
        token = secrets.token_urlsafe(32)
        runner, port = await start_gateway(devices, token, primary_role, background_requested)
        print(json.dumps({'event': 'ready', 'gatewayUrl': f'http://127.0.0.1:{port}', 'token': token, 'healthCheck': True,
                          'devices': [device.descriptor() for device in devices.values()]}), flush=True)
        background = None
        if not legacy_start:
            background = asyncio.create_task(watch_background(
                background_role, lock, env, background_acceleration, devices, background_requested,
            ))
            waits.append(background)
        done, _ = await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        if background is not None and background in done and not background.result():
            # A failed background boot leaves the verified current app usable.
            await primary_exit
        if not stop.is_set():
            raise StartupError('An Android emulator exited. Restart the App Studio runtime.')
    finally:
        for task in waits:
            task.cancel()
        try:
            if runner is not None:
                await runner.cleanup()
        finally:
            outcomes = await asyncio.gather(*waits, *(device.close() for device in devices.values()),
                                            return_exceptions=True)
            if any(isinstance(result, Exception) for result in outcomes[len(waits):]):
                raise StartupCleanupError('Could not close the App Studio Android emulators.') from None


async def supervise(lock, primary_role, after_preview):
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop.set)

    async def receive_control(reader, writer):
        try:
            if await asyncio.wait_for(reader.readexactly(5), 1) == b'stop\n':
                stop.set()
        except (TimeoutError, ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()

    avd_home = STATE / 'devices'
    user_home = STATE / 'android-user'
    for directory in (avd_home, user_home):
        directory.mkdir(mode=0o700, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='run-', dir=STATE) as discovery_dir:
        env = {**os.environ, 'ANDROID_HOME': str(SDK), 'ANDROID_SDK_ROOT': str(SDK),
               'ANDROID_AVD_HOME': str(avd_home), 'ANDROID_USER_HOME': str(user_home),
               'XDG_RUNTIME_DIR': discovery_dir}
        CONTROL_SOCKET.unlink(missing_ok=True)
        control = await asyncio.start_unix_server(receive_control, path=CONTROL_SOCKET)
        try:
            async with control:
                worker = asyncio.create_task(run(lock, stop, env, primary_role, after_preview))
                stopping = asyncio.create_task(stop.wait())
                try:
                    await asyncio.wait((worker, stopping), return_when=asyncio.FIRST_COMPLETED)
                    if not worker.done():
                        worker.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await worker
                finally:
                    stopping.cancel()
                    await asyncio.gather(stopping, return_exceptions=True)
        finally:
            CONTROL_SOCKET.unlink(missing_ok=True)


def main():
    args = sys.argv[1:]
    if args == ['--stop']:
        asyncio.run(stop_supervisor())
        return
    if len(args) > 2 or (args and args[0] not in ROLES):
        raise StartupError('App Studio received an invalid primary Android device role.')
    if len(args) == 2 and args[1] != 'after-preview':
        raise StartupError('App Studio received an invalid background startup mode.')
    primary_role = args[0] if args else None
    os.umask(0o077)
    with (STATE / 'supervisor.lock').open('a', encoding='utf-8') as supervisor_lock:
        try:
            fcntl.flock(supervisor_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('App Studio runtime is already running.', file=sys.stderr)
            sys.exit(75)
        print('{"event":"starting"}', flush=True)
        lock = json.loads((RUNTIME / 'runtime-lock.json').read_text(encoding='utf-8'))
        verify_sdk(lock)
        asyncio.run(supervise(lock, primary_role, len(args) == 2))


if __name__ == '__main__':
    try:
        main()
    except (StartupError, StartupCleanupError, OSError, TimeoutError, ValueError, KeyError, subprocess.SubprocessError) as error:
        report_runtime_error(error)
        sys.exit(1)
