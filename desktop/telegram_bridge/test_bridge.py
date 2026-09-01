from __future__ import annotations

import asyncio
from pathlib import Path
import tempfile
import time
import unittest

import bridge


class FakeUploadClient:
    def __init__(self) -> None:
        self.parts: list[int] = []

    async def __call__(self, request):
        self.parts.append(int(request.file_part))
        return True


class BridgeResumeTests(unittest.TestCase):
    def test_upload_session_state_is_persistent_and_advances(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = bridge.BridgeState(Path(directory) / 'state.sqlite3')
            state.save_upload_session({
                'asset_id': 'asset-12345678',
                'content_hash': 'a' * 64,
                'file_id': 123,
                'file_name': 'x.bin',
                'size_bytes': 20 * 1024 * 1024,
                'part_size': bridge.TELEGRAM_PART_SIZE_BYTES,
                'total_parts': 40,
                'next_part': 3,
                'created_at': time.time(),
            })
            self.assertEqual(state.upload_session('asset-12345678')['next_part'], 3)
            state.advance_upload_session('asset-12345678', 4)
            self.assertEqual(state.upload_session('asset-12345678')['next_part'], 4)
            state.delete_upload_session('asset-12345678')
            self.assertIsNone(state.upload_session('asset-12345678'))

    def test_large_upload_resumes_at_first_unconfirmed_part(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                payload = root / 'x.bin'
                payload.write_bytes(b'x' * (2 * bridge.TELEGRAM_PART_SIZE_BYTES))
                engine = bridge.TelegramEngine.__new__(bridge.TelegramEngine)
                engine.state = bridge.BridgeState(root / 'state.sqlite3')
                engine.client = FakeUploadClient()
                engine.state.save_upload_session({
                    'asset_id': 'asset-12345678',
                    'content_hash': 'b' * 64,
                    'file_id': 123,
                    'file_name': 'x.bin',
                    'size_bytes': payload.stat().st_size,
                    'part_size': bridge.TELEGRAM_PART_SIZE_BYTES,
                    'total_parts': 2,
                    'next_part': 1,
                    'created_at': time.time(),
                })
                handle, resumed_bytes = await engine._upload_large_resumable(
                    'asset-12345678', payload, 'x.bin', payload.stat().st_size, 'b' * 64,
                )
                self.assertEqual(engine.client.parts, [1])
                self.assertEqual(resumed_bytes, bridge.TELEGRAM_PART_SIZE_BYTES)
                self.assertEqual(handle.parts, 2)
                self.assertEqual(engine.state.upload_session('asset-12345678')['next_part'], 2)

        asyncio.run(scenario())

    def test_expired_upload_session_is_not_reused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine = bridge.TelegramEngine.__new__(bridge.TelegramEngine)
            engine.state = bridge.BridgeState(root / 'state.sqlite3')
            engine.state.save_upload_session({
                'asset_id': 'asset-12345678',
                'content_hash': 'c' * 64,
                'file_id': 123,
                'file_name': 'x.bin',
                'size_bytes': 20 * 1024 * 1024,
                'part_size': bridge.TELEGRAM_PART_SIZE_BYTES,
                'total_parts': 40,
                'next_part': 10,
                'created_at': time.time() - bridge.UPLOAD_SESSION_TTL_SECONDS - 1,
            })
            self.assertIsNone(engine._matching_upload_session('asset-12345678', 'x.bin', 20 * 1024 * 1024, 'c' * 64))
            self.assertIsNone(engine.state.upload_session('asset-12345678'))


if __name__ == '__main__':
    unittest.main()
