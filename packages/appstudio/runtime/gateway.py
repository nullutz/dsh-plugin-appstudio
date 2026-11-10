#!/usr/bin/env python3
import asyncio
import contextlib
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
DISCOVERY_TIMEOUT = 35
DESKTOP_INPUT_TIMEOUT = 15
SHUTDOWN_TIMEOUT = 8
EMULATOR_LOG_LIMIT = 8192
FRAME_LIMIT = 128 * 1024


class StartupError(Exception):
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
        actual = properties(folder / 'source.properties')
        if any(actual.get(key) != value for key, value in expected.items()):
            raise StartupError(f'Unexpected Android SDK package {folder.name}. Reinitialize App Studio.')
    if not (image_path / 'system.img').is_file():
        raise StartupError('The pinned Android system image is missing. Reinitialize App Studio.')
    result = subprocess.run([SDK / 'platform-tools/adb', 'version'], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, timeout=10, check=False)
    if result.returncode or android['platformTools']['buildId'] not in result.stdout:
        raise StartupError('Unexpected ADB build. Reinitialize App Studio.')


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


def configure_avd(config, width, height):
    settings = {
        'hw.lcd.width': str(width), 'hw.lcd.height': str(height), 'hw.lcd.density': '320',
        'hw.ramSize': '3072', 'hw.cpu.ncore': '2', 'hw.keyboard': 'yes',
    }
    lines = [line for line in config.read_text(encoding='utf-8').splitlines()
             if line.partition('=')[0].strip() not in settings]
    lines.extend(f'{key}={value}' for key, value in settings.items())
    temporary = config.with_suffix('.appstudio.tmp')
    temporary.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    temporary.replace(config)


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
                                   env=self.env, stdin=asyncio.subprocess.PIPE)
            try:
                await asyncio.wait_for(creation.communicate(b'no\n'), 90)
            finally:
                await stop_process(creation)
            if creation.returncode or not config.is_file():
                raise StartupError(f'Could not create the {self.role} Android virtual device.')
        configured_image = properties(config).get('image.sysdir.1', '').rstrip('/').split('/')
        if configured_image != image.split(';'):
            raise StartupError(f'Unexpected system image for {self.role}. Reinitialize App Studio.')
        configure_avd(config, self.width, self.height)

    async def start(self):
        self.process = await spawn(
            SDK / 'emulator/emulator', '-avd', self.name,
            '-grpc-use-token', '-grpc-allowlist', RUNTIME / 'rtc-allowlist.json',
            '-no-window', '-no-audio', '-no-snapshot', '-gpu', self.android['emulator']['rendering'],
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
        diagnostics = []
        for line in self.log_tail.decode('utf-8', errors='replace').splitlines():
            if (re.search(r'\b(?:error|fatal)\b', line, re.IGNORECASE) and
                    not re.search(r'\b(?:token|authorization|bearer|password|credential|secret)\b', line, re.IGNORECASE)):
                printable = ''.join(char for char in line if char.isprintable()).strip()
                diagnostics.append(re.sub(r'\b[A-Za-z0-9_-]{24,}\b', '[redacted]', printable)[:180])
        detail = ' '.join(diagnostics[-2:])
        return StartupError(f'{message} {detail}' if detail else message)

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
            raise StartupError(f'The {self.role} Android device did not boot in time.') from None
        raise await self.startup_error(
            f'The {self.role} Android emulator exited during startup (code {self.process.returncode}).')

    async def close(self):
        try:
            if self.process is not None:
                if self.process.returncode is None and self.controller is not None:
                    with contextlib.suppress(TimeoutError):
                        async with asyncio.timeout(SHUTDOWN_TIMEOUT):
                            with contextlib.suppress(grpc.RpcError):
                                await self.controller.setVmState(controller_pb.VmRunState(state=controller_pb.VmRunState.SHUTDOWN),
                                                                 metadata=self.metadata, timeout=RPC_TIMEOUT)
                            await self.process.wait()
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


async def run_peer(ws, device):
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


async def start_gateway(devices, token):
    active = set()

    def authorize(request):
        authorization = request.headers.get('Authorization', '')
        if not secrets.compare_digest(authorization.encode('utf-8'), f'Bearer {token}'.encode('ascii')):
            raise web.HTTPUnauthorized()
        role = request.match_info['role']
        if role not in devices:
            raise web.HTTPNotFound()
        return role

    async def signal_handler(request):
        device = devices[authorize(request)]
        if device.peer.locked():
            raise web.HTTPConflict()
        async with device.peer:
            ws = web.WebSocketResponse(timeout=2, heartbeat=20, max_msg_size=FRAME_LIMIT, compress=False)
            await ws.prepare(request)
            active.add(ws)
            try:
                await run_peer(ws, device)
            finally:
                active.discard(ws)
            return ws

    async def scene_handler(request):
        scene = devices[authorize(request)].scene
        operation = request.match_info['operation']
        try:
            arguments = parse_scene_request(await request.read(), operation)
            async with scene.lock:
                if operation == 'capture':
                    result = await scene.capture(*arguments)
                else:
                    result = await scene.deploy(*arguments)
            return web.json_response(result)
        except SceneError as error:
            return web.json_response({'error': str(error)}, status=error.status)

    async def close_peers(_app):
        await asyncio.gather(*(ws.close(code=WSCloseCode.GOING_AWAY) for ws in active), return_exceptions=True)

    app = web.Application(client_max_size=REQUEST_LIMIT)
    app.router.add_get('/v1/devices/{role}/signal', signal_handler)
    app.router.add_post('/v1/devices/{role}/{operation:capture|deploy}', scene_handler)
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


async def run(lock, stop, env):
    devices = {role: Device(role, lock, env) for role in ROLES}
    runner = None
    waits = []
    try:
        for device in devices.values():
            await device.prepare_avd()
            await device.start()
            await device.wait_discovery()
        try:
            async with asyncio.TaskGroup() as group:
                for device in devices.values():
                    group.create_task(device.wait_ready())
        except* StartupError as errors:
            raise StartupError(str(errors.exceptions[0])) from None
        token = secrets.token_urlsafe(32)
        runner, port = await start_gateway(devices, token)
        print(json.dumps({'event': 'ready', 'gatewayUrl': f'http://127.0.0.1:{port}', 'token': token,
                          'devices': [device.descriptor() for device in devices.values()]}), flush=True)
        waits = [asyncio.create_task(device.process.wait()) for device in devices.values()]
        await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        if not stop.is_set():
            raise StartupError('An Android emulator exited. Restart the App Studio runtime.')
    finally:
        for task in waits:
            task.cancel()
        await asyncio.gather(*waits, return_exceptions=True)
        try:
            if runner is not None:
                await runner.cleanup()
        finally:
            await asyncio.gather(*(device.close() for device in devices.values()))


async def supervise(lock):
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
                worker = asyncio.create_task(run(lock, stop, env))
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
    if sys.argv[1:] == ['--stop']:
        asyncio.run(stop_supervisor())
        return
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
        asyncio.run(supervise(lock))


if __name__ == '__main__':
    try:
        main()
    except StartupError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    except (OSError, TimeoutError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f'App Studio gateway could not complete the runtime operation ({type(error).__name__}).', file=sys.stderr)
        sys.exit(1)
