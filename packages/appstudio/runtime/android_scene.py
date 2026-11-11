"""Deploy a debug APK and prove its process restored the requested scene."""

import asyncio
import contextlib
import json
from pathlib import Path
import re
import shlex


PROJECTS = Path('/opt/appstudio/projects')
SCENE_FILE = 'files/appstudio-scene.json'
RESUME_FILE = 'files/appstudio-resume.json'
RESUME_STAGING = 'files/.appstudio-resume.tmp'
SCENE_LIMIT = 256 * 1024
REQUEST_LIMIT = SCENE_LIMIT + 4096
COMMAND_LIMIT = 512 * 1024
APPLICATION_ID = re.compile(r'[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+')
ACTIVITY = re.compile(r'\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*')
VERSION = re.compile(r'[1-9][0-9]{0,18}')
SERIAL = re.compile(r'emulator-[0-9]{1,5}')
SNAPSHOT_KEYS = {'pid', 'versionCode', 'scene'}


class SceneError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def valid_pid(value):
    return type(value) is int and 0 < value < 2**31


def valid_version(value):
    return isinstance(value, str) and VERSION.fullmatch(value) and int(value) < 2**63


def encode_scene(scene):
    try:
        encoded = json.dumps(scene, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SceneError('Scene state must be valid JSON.') from error
    if len(encoded) > SCENE_LIMIT:
        raise SceneError('The debug scene state exceeds 256 KiB.')
    return encoded


def preserves_scene(source, restored):
    """Allow additional object fields while preserving all existing scene data."""
    values = [(source, restored)]
    while values:
        previous, current = values.pop()
        if type(previous) is not type(current):
            return False
        if isinstance(previous, dict):
            if not previous.keys() <= current.keys():
                return False
            values.extend((value, current[key]) for key, value in previous.items())
        elif isinstance(previous, list):
            if len(previous) != len(current):
                return False
            values.extend(zip(previous, current))
        elif previous != current:
            return False
    return True


def checkpoint_from_hook(raw, pid=None):
    try:
        exported = json.loads(raw)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise SceneError('The app published an invalid debug scene checkpoint.') from error
    if (not isinstance(exported, dict) or not valid_pid(exported.get('pid')) or
            (pid is not None and exported['pid'] != pid) or
            type(exported.get('nativeVersion')) not in (int, str) or not valid_version(str(exported['nativeVersion']))):
        raise SceneError('The app has not published a checkpoint for its current process.')
    version = str(exported.pop('nativeVersion'))
    saved_pid = exported.pop('pid')
    encode_scene(exported)
    return {'pid': saved_pid, 'versionCode': version, 'scene': exported}


def checkpoint_for_resume(checkpoint):
    if (not isinstance(checkpoint, dict) or set(checkpoint) != SNAPSHOT_KEYS or not valid_pid(checkpoint['pid']) or
            not valid_version(checkpoint['versionCode']) or not isinstance(checkpoint['scene'], dict) or
            {'pid', 'nativeVersion'}.intersection(checkpoint['scene'])):
        raise SceneError('Invalid source scene checkpoint.', 400)
    return encode_scene({**checkpoint['scene'], 'pid': checkpoint['pid'], 'nativeVersion': int(checkpoint['versionCode'])})


def resolve_apk(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 4096 or '\x00' in value:
        raise SceneError('Invalid APK path.', 400)
    apk = Path(value)
    try:
        relative = apk.relative_to(PROJECTS)
        project, source, *remaining = relative.parts
        if (not re.fullmatch(r'[0-9a-f]{32}', project) or source != 'source' or not remaining or
                '..' in relative.parts or apk.suffix != '.apk'):
            raise ValueError
        apk = apk.resolve(strict=True)
        if not apk.is_relative_to(PROJECTS / project / 'source') or apk.suffix != '.apk' or not apk.is_file():
            raise ValueError
    except (OSError, ValueError, RuntimeError) as error:
        raise SceneError('The APK is unavailable in the staged project source.', 400) from error
    return apk


async def read_output(stream):
    result = bytearray()
    while chunk := await stream.read(65536):
        result.extend(chunk)
        if len(result) > COMMAND_LIMIT:
            raise SceneError('Android command output exceeded its limit.')
    return bytes(result)


class AndroidScene:
    def __init__(self, device, adb):
        self.device = device
        self.adb = adb
        self.lock = asyncio.Lock()

    async def run_adb(self, *args, payload=None, timeout=20):
        process = await asyncio.create_subprocess_exec(
            self.adb, *args, env=self.device.env,
            stdin=asyncio.subprocess.PIPE if payload is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            async with asyncio.timeout(timeout):
                if payload is not None:
                    process.stdin.write(payload)
                    with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                        await process.stdin.drain()
                    process.stdin.close()
                output = await read_output(process.stdout)
                return await process.wait(), output
        except TimeoutError as error:
            raise SceneError('An Android command timed out.') from error
        finally:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                with contextlib.suppress(TimeoutError):
                    async with asyncio.timeout(2):
                        await process.stdout.read()
                        await process.wait()

    async def device_serial(self):
        status, devices = await self.run_adb('devices')
        if status != 0:
            raise SceneError('ADB is unavailable in the Android runtime.', 409)
        matches = []
        for line in devices.decode('utf-8', errors='replace').splitlines():
            columns = line.split()
            if len(columns) != 2 or not SERIAL.fullmatch(columns[0]) or columns[1] != 'device':
                continue
            serial = columns[0]
            status, result = await self.run_adb('-s', serial, 'emu', 'avd', 'name', timeout=5)
            if status == 0 and result.decode('utf-8', errors='replace').splitlines() == [self.device.name, 'OK']:
                matches.append(serial)
        if len(matches) != 1 or self.device.process.returncode is not None:
            raise SceneError('ADB could not identify the selected App Studio emulator.', 409)
        return matches[0]

    async def shell(self, serial, *args, payload=None, timeout=20):
        # ADB forwards one shell command to Android; quote each already validated argument.
        return await self.run_adb('-s', serial, 'shell', '-T', shlex.join(args), payload=payload, timeout=timeout)

    async def checked_shell(self, serial, message, *args, **options):
        code, output = await self.shell(serial, *args, **options)
        if code != 0:
            raise SceneError(message)
        return output

    async def configure_desktop_input(self):
        serial = await self.device_serial()
        # Gboard can enter stylus mode on an emulator touch and consume the
        # first letter when it switches back to the desktop hardware keyboard.
        await self.checked_shell(serial, 'Could not configure Android desktop input.',
                                 'settings', '--user', 'current', 'put', 'secure',
                                 'stylus_handwriting_enabled', '0', timeout=5)

    async def app_pid(self, serial, application):
        code, output = await self.shell(serial, 'pidof', application, timeout=5)
        if code == 1 and not output.strip():
            return None
        value = output.strip()
        if code != 0 or not value.isdigit() or not valid_pid(int(value)):
            raise SceneError('ADB could not determine the current Android app process.')
        return int(value)

    async def read_checkpoint(self, serial, application, pid=None):
        code, raw = await self.shell(serial, 'run-as', application, 'cat', SCENE_FILE, timeout=5)
        if code != 0:
            raise SceneError('The app has not published an App Studio debug scene checkpoint.')
        if len(raw) > SCENE_LIMIT:
            raise SceneError('The app debug scene checkpoint exceeds 256 KiB.')
        return checkpoint_from_hook(raw, pid)

    async def capture_for_pid(self, serial, application, pid):
        checkpoint = await self.read_checkpoint(serial, application, pid)
        if await self.app_pid(serial, application) != pid:
            raise SceneError('The Android app restarted while its scene was being captured.')
        return checkpoint

    async def capture(self, application):
        serial = await self.device_serial()
        pid = await self.app_pid(serial, application)
        if pid is None:
            raise SceneError('Start the Android app before capturing its scene.')
        return await self.capture_for_pid(serial, application, pid)

    async def wait_for_checkpoint(self, serial, application, previous_pid, expected_version, expected_scene,
                                  *, allow_additions=False):
        exact = encode_scene(expected_scene) if expected_scene is not None and not allow_additions else None
        deadline = asyncio.get_running_loop().time() + 50
        failure = SceneError('The installed Android app did not start a fresh process.')
        while asyncio.get_running_loop().time() < deadline:
            pid = await self.app_pid(serial, application)
            if pid is not None and pid != previous_pid:
                try:
                    checkpoint = await self.capture_for_pid(serial, application, pid)
                    if checkpoint['versionCode'] != expected_version:
                        raise SceneError('The running Android app version does not match the built APK.')
                    if expected_scene is not None:
                        scene = checkpoint['scene']
                        restored = preserves_scene(expected_scene, scene) if allow_additions else encode_scene(scene) == exact
                        if not restored:
                            raise SceneError('The app did not restore the captured scene in its new process.')
                        await self.checked_shell(serial, 'The app did not consume the resume checkpoint.',
                                                 'run-as', application, 'test', '!', '-e', RESUME_FILE, timeout=5)
                    return checkpoint
                except SceneError as error:
                    failure = error
            await asyncio.sleep(0.4)
        raise failure

    async def verify_installed_version(self, serial, application, version):
        package_info = await self.checked_shell(serial, 'Could not verify the installed Android package.',
                                                'dumpsys', 'package', application)
        installed = re.search(rb'^\s+versionCode=([0-9]+)\b', package_info, re.MULTILINE)
        if not installed or installed[1].decode('ascii') != version:
            raise SceneError('The installed Android package does not match the expected version.')

    async def stage_resume(self, serial, application, payload):
        await self.checked_shell(serial, 'Could not write the source scene into the debug app.',
                                 'run-as', application, 'sh', '-c', 'cat > "$1"', 'appstudio', RESUME_STAGING,
                                 payload=payload)
        await self.checked_shell(serial, 'Could not commit the source scene for the new app process.',
                                 'run-as', application, 'mv', '-f', RESUME_STAGING, RESUME_FILE)

    async def clear_resume(self, serial, application):
        with contextlib.suppress(SceneError):
            await self.shell(serial, 'run-as', application, 'rm', '-f', RESUME_FILE, RESUME_STAGING, timeout=5)

    async def is_foreground(self, serial, application):
        activities = await self.checked_shell(serial, 'Could not verify the foreground Android activity.',
                                              'dumpsys', 'activity', 'activities', timeout=5)
        return bool(re.search(rb'^\s*topResumedActivity=ActivityRecord\{[^\r\n]*\su\d+\s+' +
                              re.escape(application.encode('ascii')) + rb'/', activities, re.MULTILINE))

    async def launcher_component(self, serial, application):
        result = await self.checked_shell(serial, 'Could not resolve the installed Android launcher activity.',
                                          'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN',
                                          '-c', 'android.intent.category.LAUNCHER', '-p', application, timeout=5)
        for line in result.decode('ascii', errors='replace').splitlines():
            package, separator, activity = line.strip().partition('/')
            if separator and package == application and ACTIVITY.fullmatch(activity):
                return line.strip()
        raise SceneError('The installed Android app has no matching launcher activity.')

    async def resume(self, application, version):
        serial = await self.device_serial()
        await self.verify_installed_version(serial, application, version)
        pid = await self.app_pid(serial, application)
        if pid is not None and await self.is_foreground(serial, application):
            checkpoint = await self.capture_for_pid(serial, application, pid)
            if checkpoint['versionCode'] != version:
                raise SceneError('The running Android app version does not match the expected version.')
            return checkpoint

        component = await self.launcher_component(serial, application)
        saved = None
        if pid is None:
            with contextlib.suppress(SceneError):
                checkpoint = await self.read_checkpoint(serial, application)
                if checkpoint['versionCode'] == version:
                    saved = checkpoint
        try:
            if saved is not None:
                await self.stage_resume(serial, application, checkpoint_for_resume(saved))
            launch = await self.checked_shell(serial, 'Could not open the installed Android app.',
                                              'am', 'start', '-W', '-a', 'android.intent.action.MAIN',
                                              '-c', 'android.intent.category.LAUNCHER', '-n', component, timeout=30)
            if not re.search(rb'^Status:\s+ok\s*$', launch, re.MULTILINE):
                raise SceneError('Android did not open the installed debug activity.')
            expected_scene = saved['scene'] if saved is not None else None
            checkpoint = await self.wait_for_checkpoint(serial, application, None, version, expected_scene)
            if not await self.is_foreground(serial, application):
                raise SceneError('The installed Android app did not reach the foreground.')
            return checkpoint
        finally:
            if saved is not None:
                await self.clear_resume(serial, application)

    async def deploy(self, application, activity, version, apk, source):
        resume_payload = checkpoint_for_resume(source) if source is not None else None
        expected_scene = source['scene'] if source is not None else None
        serial = await self.device_serial()
        previous_pid = await self.app_pid(serial, application)
        await self.checked_shell(serial, 'Could not stop the previous Android app process.', 'am', 'force-stop', application)
        code, output = await self.run_adb('-s', serial, 'install', '-r', '-d', '-t', str(apk), timeout=180)
        if code != 0 or b'Success' not in output.splitlines():
            diagnostic = next((line.strip() for line in output.decode('utf-8', errors='replace').splitlines()
                               if 'INSTALL_FAILED_' in line), '')
            raise SceneError('ADB could not install the debug APK.' + (' ' + diagnostic[:240] if diagnostic else ''))
        await self.verify_installed_version(serial, application, version)
        await self.checked_shell(serial, 'The installed app must be debuggable to access its scene.',
                                 'run-as', application, 'mkdir', '-p', 'files')
        await self.checked_shell(serial, 'Could not clear stale scene transfer files.',
                                 'run-as', application, 'rm', '-f', RESUME_FILE, RESUME_STAGING)
        try:
            if resume_payload is not None:
                await self.stage_resume(serial, application, resume_payload)
            launch = await self.checked_shell(serial, 'Could not launch the installed debug activity.',
                                              'am', 'start', '-W', '-n', f'{application}/{activity}', timeout=60)
            if not re.search(rb'^Status:\s+ok\s*$', launch, re.MULTILINE):
                raise SceneError('Android did not start the installed debug activity.')
            checkpoint = await self.wait_for_checkpoint(serial, application, previous_pid, version, expected_scene,
                                                        allow_additions=True)
            return {'pid': checkpoint['pid'], 'previousPid': previous_pid, 'sceneRestored': source is not None,
                    'checkpoint': checkpoint}
        finally:
            if resume_payload is not None:
                await self.clear_resume(serial, application)


def parse_scene_request(raw, operation):
    try:
        payload = json.loads(raw)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise SceneError('Expected a JSON scene request.', 400) from error
    application = payload.get('applicationId') if isinstance(payload, dict) else None
    if not isinstance(application, str) or len(application) > 255 or not APPLICATION_ID.fullmatch(application):
        raise SceneError('Invalid Android application ID.', 400)
    if operation == 'capture':
        if set(payload) != {'applicationId'}:
            raise SceneError('Invalid capture request fields.', 400)
        return (application,)
    if operation == 'resume':
        if set(payload) != {'applicationId', 'versionCode'} or not valid_version(payload['versionCode']):
            raise SceneError('Invalid resume request fields.', 400)
        return application, payload['versionCode']
    if set(payload) - {'applicationId', 'activity', 'versionCode', 'apkPath', 'checkpoint'}:
        raise SceneError('Invalid deploy request fields.', 400)
    activity = payload.get('activity')
    version = payload.get('versionCode')
    if not isinstance(activity, str) or len(activity) > 255 or not ACTIVITY.fullmatch(activity):
        raise SceneError('Invalid Android activity class.', 400)
    if not valid_version(version):
        raise SceneError('Invalid Android version code.', 400)
    checkpoint = payload.get('checkpoint')
    if 'checkpoint' in payload:
        checkpoint_for_resume(checkpoint)
    return application, activity, version, resolve_apk(payload.get('apkPath')), checkpoint
