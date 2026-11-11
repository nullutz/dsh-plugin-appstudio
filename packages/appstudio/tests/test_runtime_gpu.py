import asyncio
import errno
import importlib.util
import io
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


RUNTIME = Path(__file__).resolve().parents[1] / 'runtime'
sys.path.insert(0, str(RUNTIME))

# The startup coordinator can be tested without the guest's Linux/RTC modules.
spec = importlib.util.spec_from_file_location('appstudio_gateway_startup_test', RUNTIME / 'gateway.py')
gateway = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {module: MagicMock() for module in (
    'fcntl', 'aiohttp', 'google.protobuf.empty_pb2', 'grpc', 'emulator_controller_pb2',
    'emulator_controller_pb2_grpc', 'ice_config_pb2', 'rtc_service_v2_pb2', 'rtc_service_v2_pb2_grpc',
)}):
    spec.loader.exec_module(gateway)

LOCK = {'android': {'emulator': {'rendering': 'swiftshader'}}}


class RuntimeEnvironmentTests(unittest.TestCase):
    def test_avd_hardware_respects_the_guest_limits(self):
        for cpu, memory, expected in (
            (2, 4096, (1, 2048)),
            (8, 7168, (2, 2048)),
            (8, 8192, (2, 3072)),
            (4, 0, (2, 3072)),
        ):
            with self.subTest(cpu=cpu, memory=memory), \
                    patch.object(gateway.os, 'sched_getaffinity', return_value=set(range(cpu)), create=True), \
                    patch.object(gateway.os, 'sysconf', side_effect=[memory * 256, 4096], create=True):
                self.assertEqual(gateway.emulator_resources(), expected)

    def test_configure_avd_keeps_the_existing_image_and_data_settings(self):
        with TemporaryDirectory() as directory:
            config = Path(directory) / 'config.ini'
            config.write_text('image.sysdir.1=system-images/android-36/google_apis/x86_64/\n'
                              'disk.dataPartition.path=userdata-qemu.img\nhw.ramSize=3072\nhw.cpu.ncore=2\n',
                              encoding='utf-8')
            with patch.object(gateway, 'emulator_resources', return_value=(1, 2048)):
                gateway.configure_avd(config, 720, 1280)
            actual = gateway.properties(config)
            self.assertEqual(actual['image.sysdir.1'], 'system-images/android-36/google_apis/x86_64/')
            self.assertEqual(actual['disk.dataPartition.path'], 'userdata-qemu.img')
            self.assertEqual(actual['hw.ramSize'], '2048')
            self.assertEqual(actual['hw.cpu.ncore'], '1')
            self.assertEqual((actual['hw.lcd.width'], actual['hw.lcd.height']), ('720', '1280'))

    def test_emulator_errors_expose_only_classified_guidance(self):
        for message, code in (
            ('could not open /dev/kvm', 'kvm-unavailable'),
            ('No space left on device', 'runtime-storage'),
            ('failed to allocate memory', 'guest-resources'),
            ('broken AVD system path', 'sdk-invalid'),
            ('another emulator instance', 'avd-startup'),
            ('Unfamiliar backend crash', 'avd-startup'),
        ):
            with self.subTest(message=message):
                failure = gateway.emulator_startup_error(
                    'Could not boot.', f'ERROR {message} at C:\\Users\\PrivateName, abc123@example.test'.encode(),
                )
                self.assertEqual(failure.code, code)
                self.assertIn('Could not boot.', str(failure))
                self.assertNotIn('PrivateName', str(failure))
                self.assertNotIn('abc123', str(failure))

    def test_storage_errno_produces_a_machine_readable_error(self):
        stderr = io.StringIO()
        with patch('sys.stderr', stderr):
            gateway.report_runtime_error(OSError(errno.ENOSPC, 'arbitrary private data'))
        self.assertIn('APPSTUDIO_RUNTIME_ERROR runtime-storage\n', stderr.getvalue())
        self.assertNotIn('arbitrary private data', stderr.getvalue())


class GraphicsStartupTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, failure=None, cleanup_error=False):
        calls = []
        waiting = asyncio.Event()

        class TestDevice:
            def __init__(self, role, lock, env):
                self.role = role
                self.process = MagicMock(returncode=None)

            async def prepare_avd(self):
                calls.append((self.role, 'prepare'))

            async def start(self, rendering):
                self.rendering = rendering
                calls.append((self.role, 'start', rendering))

            async def wait_discovery(self):
                if failure == 'discovery' and self.rendering == 'host' and self.role == 'candidate':
                    raise gateway.StartupError('GPU init failed')

            async def wait_ready(self):
                if failure == 'wait' and self.rendering == 'host':
                    waiting.set()
                    await asyncio.Future()

            async def close(self):
                if cleanup_error:
                    raise OSError('fixture process cleanup failed')
                await asyncio.sleep(0)
                calls.append((self.role, 'close', self.rendering))

        return TestDevice, calls, waiting

    async def test_hardware_failure_closes_only_its_device_before_retry_without_recreating_avd(self):
        device, calls, _ = self.fixture('discovery')
        with patch.object(gateway, 'Device', device), patch('sys.stderr', io.StringIO()):
            started, hardware = await gateway.start_device('candidate', LOCK, {}, {'GALLIUM_DRIVER': 'd3d12'})

        self.assertEqual(started.role, 'candidate')
        self.assertFalse(hardware)
        self.assertEqual(calls, [
            ('candidate', 'prepare'), ('candidate', 'start', 'host'),
            ('candidate', 'close', 'host'), ('candidate', 'start', 'swiftshader'),
        ])

    async def test_canceling_startup_never_launches_a_fallback(self):
        device, calls, waiting = self.fixture('wait')
        with patch.object(gateway, 'Device', device):
            startup = asyncio.create_task(gateway.start_device('live', LOCK, {}, {'GALLIUM_DRIVER': 'd3d12'}))
            await waiting.wait()
            startup.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await startup

        self.assertEqual(calls[-1], ('live', 'close', 'host'))
        self.assertNotIn(('live', 'start', 'swiftshader'), calls)

    async def test_cleanup_error_prevents_starting_a_duplicate_avd(self):
        device, calls, _ = self.fixture('discovery', cleanup_error=True)
        with patch.object(gateway, 'Device', device), self.assertRaises(gateway.StartupCleanupError):
            await gateway.start_device('candidate', LOCK, {}, {'GALLIUM_DRIVER': 'd3d12'})
        self.assertNotIn(('candidate', 'start', 'swiftshader'), calls)


class PrimaryFirstTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.started = []
        self.closed = []
        self.exits = {role: asyncio.Event() for role in gateway.ROLES}
        self.background_started = asyncio.Event()
        self.continue_background = asyncio.Event()
        self.gateway_ready = asyncio.Event()
        self.background_failed = False
        self.runner = AsyncMock()
        self.stdout = io.StringIO()

        def ready_device(role):
            device = MagicMock()
            device.role = role
            device.process.wait = self.exits[role].wait
            device.descriptor.return_value = {'id': role, 'width': 720, 'height': 1280}

            async def close():
                self.closed.append(role)

            device.close = close
            return device

        async def start(role, lock, env, accelerated):
            self.started.append(role)
            if len(self.started) == 2:
                self.background_started.set()
                await self.continue_background.wait()
                if self.background_failed:
                    raise gateway.StartupError('Fixture failed to boot.')
            return ready_device(role), False

        async def open_gateway(*_args):
            self.gateway_ready.set()
            return self.runner, 12345

        self.gateway = AsyncMock(side_effect=open_gateway)
        for test_patch in (
            patch.object(gateway, 'start_device', side_effect=start),
            patch.object(gateway, 'start_gateway', self.gateway),
            patch.object(gateway, 'accelerated_environment', AsyncMock(return_value=None)),
            patch('sys.stdout', self.stdout),
            patch('sys.stderr', io.StringIO()),
        ):
            test_patch.start()
            self.addCleanup(test_patch.stop)

    def events(self):
        return [json.loads(line) for line in self.stdout.getvalue().splitlines()]

    async def test_publishes_saved_physical_candidate_before_live_role_finishes(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, 'candidate'))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.assertEqual(self.started, ['candidate', 'live'])
        devices = self.gateway.call_args.args[0]
        self.assertEqual(list(devices), ['candidate'])
        self.assertEqual([device['id'] for device in self.events()[0]['devices']], ['candidate'])
        self.assertEqual(self.events()[0]['event'], 'ready')
        self.assertTrue(self.events()[0]['healthCheck'])
        self.continue_background.set()
        await asyncio.sleep(0)
        self.assertEqual(list(devices), ['candidate', 'live'])
        self.assertEqual(self.events()[1], {'event': 'device-ready', 'device': {'id': 'live', 'width': 720, 'height': 1280}})

        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.runner.cleanup.assert_awaited_once()
        self.assertCountEqual(self.closed, ['candidate', 'live'])

    async def test_background_boot_failure_keeps_primary_serving(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, 'live'))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.background_failed = True
        self.continue_background.set()
        await asyncio.sleep(0)
        self.assertEqual(self.events()[1], {'event': 'device-error', 'role': 'candidate',
                                             'code': 'avd-startup', 'detail': 'Fixture failed to boot.'})
        self.assertEqual(list(self.gateway.call_args.args[0]), ['live'])
        self.assertFalse(task.done())
        self.runner.cleanup.assert_not_awaited()

        self.exits['live'].set()
        with self.assertRaises(gateway.StartupError):
            await task
        self.assertEqual(self.closed, ['live'])

    async def test_current_exit_cancels_in_progress_background_boot(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, 'live'))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.exits['live'].set()
        with self.assertRaises(gateway.StartupError):
            await asyncio.wait_for(task, 1)
        self.assertEqual([event['event'] for event in self.events()], ['ready'])
        self.assertEqual(self.closed, ['live'])

    async def test_deferred_background_waits_for_preview_or_build_demand(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, 'candidate', after_preview=True))
        await asyncio.wait_for(self.gateway_ready.wait(), 1)
        self.assertEqual(self.started, ['candidate'])
        self.assertEqual([event['event'] for event in self.events()], ['ready'])
        requested = self.gateway.call_args.args[3]
        self.assertFalse(requested.is_set())
        requested.set()
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.assertEqual(self.started, ['candidate', 'live'])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.closed, ['candidate'])

    async def test_stop_before_preview_does_not_launch_background(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, 'live', after_preview=True))
        await asyncio.wait_for(self.gateway_ready.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.started, ['live'])
        self.assertEqual(self.closed, ['live'])

    async def test_legacy_start_announces_both_devices_together(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, None))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.assertEqual(self.started, ['live', 'candidate'])
        self.gateway.assert_not_awaited()
        self.assertEqual(self.events(), [])
        self.continue_background.set()
        await asyncio.wait_for(self.gateway_ready.wait(), 1)
        self.assertEqual([event['event'] for event in self.events()], ['ready'])
        self.assertEqual([device['id'] for device in self.events()[0]['devices']], ['live', 'candidate'])
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.runner.cleanup.assert_awaited_once()
        self.assertCountEqual(self.closed, ['live', 'candidate'])

    async def test_legacy_secondary_failure_does_not_announce_a_partial_gateway(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, None))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.background_failed = True
        self.continue_background.set()
        with self.assertRaisesRegex(gateway.StartupError, 'Fixture failed to boot'):
            await asyncio.wait_for(task, 1)
        self.gateway.assert_not_awaited()
        self.assertEqual(self.events(), [])
        self.assertEqual(self.closed, ['live'])

    async def test_legacy_primary_exit_cancels_the_secondary_startup(self):
        task = asyncio.create_task(gateway.run(LOCK, asyncio.Event(), {}, None))
        await asyncio.wait_for(self.background_started.wait(), 1)
        self.exits['live'].set()
        with self.assertRaisesRegex(gateway.StartupError, 'before both devices were ready'):
            await asyncio.wait_for(task, 1)
        self.gateway.assert_not_awaited()
        self.assertEqual(self.events(), [])
        self.assertEqual(self.closed, ['live'])


class PreviewGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_preview_marker_is_local_and_strict(self):
        for frame, valid in (
            ({'appStudioPreviewReady': True}, True),
            ({'appStudioPreviewReady': 1}, False),
            ({'appStudioPreviewReady': True, 'bye': True}, False),
        ):
            with self.subTest(frame=frame):
                ws = MagicMock(send_json=AsyncMock(), close=AsyncMock())
                ws.__aiter__.return_value = [SimpleNamespace(type=gateway.WSMsgType.TEXT, data=json.dumps(frame))]
                device = MagicMock()
                device.controller.getStatus = AsyncMock()
                device.rtc.RequestRtcStream = AsyncMock(return_value=SimpleNamespace(id=SimpleNamespace(guid='fixture')))
                device.rtc.SendJsepMessage = AsyncMock()
                requested = asyncio.Event()
                await gateway.run_peer(ws, device, requested)
                self.assertEqual(requested.is_set(), valid)
                # The sole message sent to the emulator is its normal peer cleanup.
                device.rtc.SendJsepMessage.assert_awaited_once()

    async def test_demand_requires_token_and_primary_owns_the_signal_gate(self):
        class Unauthorized(Exception):
            pass

        class BadRequest(Exception):
            pass

        ws = MagicMock(prepare=AsyncMock())
        runner = MagicMock(setup=AsyncMock(), cleanup=AsyncMock(), addresses=[('127.0.0.1', 12345)])
        web = MagicMock(HTTPUnauthorized=Unauthorized, HTTPBadRequest=BadRequest)
        web.AppRunner.return_value = runner
        web.TCPSite.return_value.start = AsyncMock()
        web.WebSocketResponse.return_value = ws
        peer = AsyncMock()
        devices = {role: SimpleNamespace(role=role, peer=asyncio.Lock()) for role in gateway.ROLES}
        requested = asyncio.Event()
        with patch.object(gateway, 'web', web), patch.object(gateway, 'run_peer', peer):
            await gateway.start_gateway(devices, 'fixture-token', 'candidate', requested)
            app = web.Application.return_value
            post = dict(call.args for call in app.router.add_post.call_args_list)['/v1/background/start']
            get = dict(call.args for call in app.router.add_get.call_args_list)
            signal = get['/v1/devices/{role}/signal']
            health = get['/v1/health']
            request = SimpleNamespace(headers={}, can_read_body=False, match_info={'role': 'candidate'})
            with self.assertRaises(Unauthorized):
                await post(request)
            with self.assertRaises(Unauthorized):
                await health(request)
            request.headers['Authorization'] = 'Bearer fixture-token'
            self.assertIs(await health(request), web.Response.return_value)
            self.assertFalse(requested.is_set())
            web.Response.reset_mock()
            request.can_read_body = True
            with self.assertRaises(BadRequest):
                await post(request)
            self.assertFalse(requested.is_set())
            await signal(request)
            peer.assert_awaited_with(ws, devices['candidate'], requested)
            request.match_info['role'] = 'live'
            await signal(request)
            peer.assert_awaited_with(ws, devices['live'], None)
            request.can_read_body = False
            await post(request)
            self.assertTrue(requested.is_set())
            web.Response.assert_called_once_with(status=204)
