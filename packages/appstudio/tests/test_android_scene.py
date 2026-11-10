import json
from pathlib import Path
import shlex
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))

from android_scene import AndroidScene, RESUME_FILE, SceneError, checkpoint_from_hook, parse_scene_request, resolve_apk


class FixtureDevice(AndroidScene):
    def __init__(self):
        super().__init__(SimpleNamespace(name='appstudio_candidate', process=SimpleNamespace(returncode=None)), 'adb')
        self.pid = 1347
        self.version = 1
        self.resume = None
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
                return 0, b'Packages:\n  Package [...]:\n    versionCode=2 minSdk=26 targetSdk=36\n'
            case ['run-as', 'dev.appstudio.fixture', 'sh', '-c', _, 'appstudio', _]:
                self.resume = json.loads(payload)
            case ['am', 'start', '-W', '-n', 'dev.appstudio.fixture/.MainActivity']:
                self.pid = 1704
                self.saved = {**self.resume, 'pid': self.pid, 'nativeVersion': self.version}
                self.resume = None
                return 0, b'Status: ok\nActivity: dev.appstudio.fixture/.MainActivity\n'
            case ['run-as', 'dev.appstudio.fixture', 'cat', 'files/appstudio-scene.json']:
                return 0, json.dumps(self.saved).encode()
            case ['run-as', 'dev.appstudio.fixture', 'test', '!', '-e', path]:
                assert path == RESUME_FILE and self.resume is None
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
