import json
from pathlib import Path
import shlex
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))

from android_scene import AndroidScene, RESUME_FILE, SceneError, checkpoint_from_hook, parse_scene_request, preserves_scene, resolve_apk


class FixtureDevice(AndroidScene):
    def __init__(self):
        super().__init__(SimpleNamespace(name='appstudio_candidate', process=SimpleNamespace(returncode=None)), 'adb')
        self.pid = 1347
        self.version = 1
        self.foreground = True
        self.resume_payload = None
        self.restored_fields = {}
        self.saved = None
        self.calls = []

    async def run_adb(self, *args, payload=None, timeout=20):
        self.calls.append(args)
        if args == ('devices',):
            return 0, b'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n'
        if args[2:] == ('emu', 'avd', 'name'):
            role = 'live' if args[1] == 'emulator-5554' else 'candidate'
            return 0, f'appstudio_{role}\r\nOK\r\n'.encode()
        assert args[:2] == ('-s', 'emulator-5556')
        if args[2] == 'install':
            self.version = 2
            return 0, b'Performing Streamed Install\nSuccess\n'
        assert args[2:4] == ('shell', '-T')
        command = shlex.split(args[4])
        match command:
            case ['settings', '--user', 'current', 'put', 'secure', 'stylus_handwriting_enabled', '0']:
                pass
            case ['pidof', 'dev.appstudio.fixture']:
                return (1, b'') if self.pid is None else (0, str(self.pid).encode())
            case ['am', 'force-stop', 'dev.appstudio.fixture']:
                self.pid = None
            case ['dumpsys', 'package', 'dev.appstudio.fixture']:
                return 0, f'Packages:\n  Package [...]:\n    versionCode={self.version} minSdk=26 targetSdk=36\n'.encode()
            case ['dumpsys', 'activity', 'activities']:
                component = 'dev.appstudio.fixture/.MainActivity' if self.foreground else 'com.android.launcher3/.Launcher'
                return 0, f'    topResumedActivity=ActivityRecord{{1ab2c u0 {component} t5}}\n'.encode()
            case ['run-as', 'dev.appstudio.fixture', 'sh', '-c', _, 'appstudio', _]:
                self.resume_payload = json.loads(payload)
            case ['am', 'start', '-W', '-n', 'dev.appstudio.fixture/.MainActivity']:
                self.pid = 1704
                self.saved = {**self.resume_payload, **self.restored_fields, 'pid': self.pid, 'nativeVersion': self.version}
                self.resume_payload = None
                return 0, b'Status: ok\nActivity: dev.appstudio.fixture/.MainActivity\n'
            case ['cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN',
                  '-c', 'android.intent.category.LAUNCHER', '-p', 'dev.appstudio.fixture']:
                return 0, b'priority=0 preferredOrder=0 match=0x108000\ndev.appstudio.fixture/.MainActivity\n'
            case ['am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
                  '-n', 'dev.appstudio.fixture/.MainActivity']:
                if self.pid is None:
                    self.pid = 1704
                    self.saved = {**(self.resume_payload or {}), 'pid': self.pid, 'nativeVersion': self.version}
                    self.resume_payload = None
                self.foreground = True
                return 0, b'Status: ok\nActivity: dev.appstudio.fixture/.MainActivity\n'
            case ['run-as', 'dev.appstudio.fixture', 'cat', 'files/appstudio-scene.json']:
                return 0, json.dumps(self.saved).encode()
            case ['run-as', 'dev.appstudio.fixture', 'test', '!', '-e', path]:
                assert path == RESUME_FILE and self.resume_payload is None
            case ['run-as', 'dev.appstudio.fixture', ('mkdir' | 'rm' | 'mv'), *_]:
                pass
            case _:
                raise AssertionError(command)
        return 0, b''


class AndroidSceneTests(unittest.IsolatedAsyncioTestCase):
    async def test_desktop_input_disables_handwriting_on_the_named_emulator(self):
        emulator = FixtureDevice()
        await emulator.configure_desktop_input()
        self.assertEqual(emulator.calls[-1], (
            '-s', 'emulator-5556', 'shell', '-T',
            'settings --user current put secure stylus_handwriting_enabled 0',
        ))

    async def test_routes_install_and_verified_restart_to_the_named_candidate(self):
        emulator = FixtureDevice()
        scene = {'route': 'detail', 'item': 'device-07', 'offset': 351, 'draft': 'unsaved note'}
        source = {'pid': 4187, 'versionCode': '1', 'scene': scene}
        result = await emulator.deploy('dev.appstudio.fixture', '.MainActivity', '2', Path('/tmp/debug.apk'), source)
        self.assertEqual(result, {'pid': 1704, 'previousPid': 1347, 'sceneRestored': True,
                                  'checkpoint': {'pid': 1704, 'versionCode': '2', 'scene': scene}})
        self.assertEqual(await emulator.capture('dev.appstudio.fixture'), result['checkpoint'])
        self.assertFalse(any(args[:2] == ('-s', 'emulator-5554') and args[2] != 'emu' for args in emulator.calls))

    async def test_candidate_can_add_fields_without_losing_the_live_scene(self):
        emulator = FixtureDevice()
        scene = {'screen': 'settings', 'drafts': {'task': 'Keep editing'}, 'offsets': {'settings': 120},
                 'sessions': [{'id': 17, 'minutes': 25}], 'timer': {'running': False, 'remaining': 52}}
        user = {'name': '番茄用户', 'avatar': '🍅', 'motto': '专注当下'}
        emulator.restored_fields = {'user': user}
        source = {'pid': 4187, 'versionCode': '1', 'scene': scene}

        result = await emulator.deploy('dev.appstudio.fixture', '.MainActivity', '2', Path('/tmp/debug.apk'), source)

        self.assertTrue(result['sceneRestored'])
        self.assertEqual(result['checkpoint'], {'pid': 1704, 'versionCode': '2', 'scene': {**scene, 'user': user}})
        self.assertEqual(await emulator.capture('dev.appstudio.fixture'), result['checkpoint'])

    def test_candidate_scene_cannot_drop_or_change_existing_data(self):
        scene = {'drafts': {'task': 'Keep editing'}, 'offsets': {'settings': 120},
                 'sessions': [{'id': 17}, {'id': 18}], 'timer': {'running': False}}
        self.assertTrue(preserves_scene(scene, {**scene, 'timer': {'running': False, 'total': 1500}}))
        for changes in (
            {'drafts': {}},
            {'offsets': {'settings': 0}},
            {'sessions': [{'id': 17}]},
            {'sessions': [{'id': 18}, {'id': 17}]},
            {'sessions': {'0': {'id': 17}, '1': {'id': 18}}},
            {'timer': {'running': 0}},
        ):
            with self.subTest(changes=changes):
                self.assertFalse(preserves_scene(scene, {**scene, **changes, 'user': {}}))

    async def test_reconnect_to_foreground_app_keeps_its_process_and_scene(self):
        emulator = FixtureDevice()
        emulator.saved = {'pid': 1347, 'nativeVersion': 1, 'route': 'statistics'}
        result = await emulator.resume('dev.appstudio.fixture', '1')
        self.assertEqual(result, {'pid': 1347, 'versionCode': '1', 'scene': {'route': 'statistics'}})
        self.assertFalse(any(args[2] == 'install' or args[-1].startswith('am ') for args in emulator.calls if len(args) > 2))

    async def test_reconnect_after_runtime_restart_uses_same_version_scene(self):
        emulator = FixtureDevice()
        emulator.pid = None
        emulator.foreground = False
        emulator.saved = {'pid': 1347, 'nativeVersion': 1, 'route': 'statistics', 'offset': 100}
        result = await emulator.resume('dev.appstudio.fixture', '1')
        self.assertEqual(result, {'pid': 1704, 'versionCode': '1', 'scene': {'route': 'statistics', 'offset': 100}})
        self.assertTrue(emulator.foreground)
        self.assertFalse(any(args[2] == 'install' or 'force-stop' in args[-1] for args in emulator.calls if len(args) > 2))

    async def test_reconnect_rejects_a_different_installed_version(self):
        emulator = FixtureDevice()
        with self.assertRaisesRegex(SceneError, 'expected version'):
            await emulator.resume('dev.appstudio.fixture', '2')
        self.assertFalse(any('am start' in args[-1] for args in emulator.calls if args))

    def test_stale_checkpoint_and_non_json_scene_are_rejected(self):
        with self.assertRaisesRegex(SceneError, 'current process'):
            checkpoint_from_hook(b'{"pid":12,"nativeVersion":2}', 13)
        with self.assertRaisesRegex(SceneError, 'valid JSON'):
            checkpoint_from_hook(b'{"pid":13,"nativeVersion":2,"offset":NaN}', 13)

    def test_request_rejects_shell_metacharacters_and_unknown_arguments(self):
        with self.assertRaisesRegex(SceneError, 'application ID'):
            parse_scene_request(b'{"applicationId":"dev.fixture;id"}', 'capture')
        with self.assertRaisesRegex(SceneError, 'fields'):
            parse_scene_request(b'{"applicationId":"dev.fixture","adb":["shell"]}', 'capture')
        self.assertEqual(parse_scene_request(b'{"applicationId":"dev.fixture","versionCode":"1"}', 'resume'),
                         ('dev.fixture', '1'))
        with self.assertRaisesRegex(SceneError, 'fields'):
            parse_scene_request(b'{"applicationId":"dev.fixture","versionCode":"1","activity":".MainActivity"}', 'resume')

    def test_apk_must_remain_in_its_staged_source_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            projects = Path(directory) / 'projects'
            source = projects / ('1' * 32) / 'source'
            source.mkdir(parents=True)
            apk = source / 'app debug.apk'
            apk.touch()
            with patch('android_scene.PROJECTS', projects):
                self.assertEqual(resolve_apk(str(apk)), apk.resolve())
                with self.assertRaisesRegex(SceneError, 'staged project'):
                    resolve_apk(str(source / '..' / 'source' / apk.name))
                with self.assertRaisesRegex(SceneError, 'staged project'):
                    resolve_apk(str(Path(directory) / 'foreign.apk'))


if __name__ == '__main__':
    unittest.main()
