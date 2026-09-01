from __future__ import annotations

import argparse
import asyncio
from contextlib import contextmanager
import ctypes
import getpass
import hashlib
import hmac
import json
import math
import mimetypes
import os
from pathlib import Path
import queue
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Iterator
from urllib.parse import parse_qs, quote, urlparse

from telethon import TelegramClient, events, functions, helpers, types, utils
try:
    import cryptg as _cryptg  # noqa: F401 - presence switches Telethon AES to native acceleration.
    CRYPTG_AVAILABLE = True
except ImportError:
    CRYPTG_AVAILABLE = False

from telethon.errors import (
    AuthKeyUnregisteredError,
    FloodWaitError,
    PasswordHashInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
    UserDeactivatedBanError,
)

SERVICE_NAME = "private-archive-telegram-storage"
EXPECTED_CHAT_TITLE = "ai"
INITIAL_CHAT_ID = "-5130794176"
DEFAULT_API_ID = 35020064
MAX_JSON_BODY = 256 * 1024
PENDING_VISIBILITY_DELAY_SECONDS = 3.0
BIG_UPLOAD_THRESHOLD_BYTES = 10 * 1024 * 1024
UPLOAD_SESSION_TTL_SECONDS = 20 * 60 * 60
TELEGRAM_PART_SIZE_BYTES = 512 * 1024
DOWNLOAD_STREAM_CHUNK_BYTES = 512 * 1024
DOWNLOAD_STREAM_QUEUE_CHUNKS = 4


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _read_signalwatch_env() -> dict[str, str]:
    path = Path(r"D:\wendangcodex\SignalWatch\.env")
    values: dict[str, str] = {}
    try:
        for raw in path.read_text(encoding="utf-8-sig").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key not in {"TELEGRAM_API_ID", "TELEGRAM_API_HASH"}:
                continue
            value = value.strip().strip('"').strip("'")
            if value:
                values[key] = value
    except OSError:
        pass
    return values


def _credentials() -> tuple[int, str]:
    env_values = _read_signalwatch_env()
    api_id_raw = os.environ.get("TELEGRAM_API_ID") or env_values.get("TELEGRAM_API_ID") or str(DEFAULT_API_ID)
    api_hash = os.environ.get("TELEGRAM_API_HASH") or env_values.get("TELEGRAM_API_HASH") or ""
    try:
        api_id = int(api_id_raw)
    except ValueError as exc:
        raise RuntimeError("TELEGRAM_API_ID_INVALID") from exc
    if not api_hash:
        raise RuntimeError("TELEGRAM_API_HASH_NOT_AVAILABLE")
    return api_id, api_hash


def _runtime_root() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        local = str(Path.home() / "AppData" / "Local")
    return Path(local) / "PrivateArchive" / "TelegramStorage"


def _harden_runtime_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            path.chmod(0o700)
        except OSError:
            pass
        return
    try:
        identity = subprocess.check_output(["whoami"], text=True, stderr=subprocess.DEVNULL).strip()
        if not identity:
            identity = getpass.getuser()
        subprocess.run(
            [
                "icacls",
                str(path),
                "/inheritance:r",
                "/grant:r",
                f"{identity}:(OI)(CI)F",
                "SYSTEM:(OI)(CI)F",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        # The bridge still binds only to loopback and never copies the session elsewhere.
        pass


def _parent_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


class BridgeState:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._init()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=10)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS pending (
                  chat_id TEXT NOT NULL,
                  message_id INTEGER NOT NULL,
                  metadata_json TEXT NOT NULL,
                  captured_at REAL NOT NULL,
                  PRIMARY KEY(chat_id, message_id)
                );
                CREATE TABLE IF NOT EXISTS web_upload_receipts (
                  asset_id TEXT PRIMARY KEY,
                  receipt_json TEXT NOT NULL,
                  created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS upload_sessions (
                  asset_id TEXT PRIMARY KEY,
                  content_hash TEXT NOT NULL,
                  file_id INTEGER NOT NULL,
                  file_name TEXT NOT NULL,
                  size_bytes INTEGER NOT NULL,
                  part_size INTEGER NOT NULL,
                  total_parts INTEGER NOT NULL,
                  next_part INTEGER NOT NULL,
                  created_at REAL NOT NULL,
                  updated_at REAL NOT NULL
                );
                """
            )

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
            return str(row["value"]) if row else default

    def set_meta(self, key: str, value: str) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def checkpoint(self) -> int:
        try:
            return max(0, int(self.get_meta("last_scanned_message_id", "0") or "0"))
        except ValueError:
            return 0

    def advance_checkpoint(self, message_id: int) -> None:
        if message_id > self.checkpoint():
            self.set_meta("last_scanned_message_id", str(message_id))

    def add_pending(self, metadata: dict[str, Any]) -> None:
        chat_id = str(metadata["chatId"])
        message_id = int(metadata["messageId"])
        with self._connect() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO pending(chat_id, message_id, metadata_json, captured_at) VALUES(?, ?, ?, ?)",
                (chat_id, message_id, json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), time.time()),
            )

    def remove_pending(self, chat_id: str, message_ids: list[int]) -> int:
        if not message_ids:
            return 0
        placeholders = ",".join("?" for _ in message_ids)
        with self._connect() as conn:
            result = conn.execute(
                f"DELETE FROM pending WHERE chat_id = ? AND message_id IN ({placeholders})",
                (chat_id, *message_ids),
            )
            return int(result.rowcount)

    def pending(self, chat_id: str, limit: int) -> list[dict[str, Any]]:
        visible_before = time.time() - PENDING_VISIBILITY_DELAY_SECONDS
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT metadata_json FROM pending WHERE chat_id = ? AND captured_at <= ? ORDER BY message_id ASC LIMIT ?",
                (chat_id, visible_before, limit),
            ).fetchall()
        values: list[dict[str, Any]] = []
        for row in rows:
            try:
                parsed = json.loads(str(row["metadata_json"]))
                if isinstance(parsed, dict):
                    values.append(parsed)
            except json.JSONDecodeError:
                continue
        return values

    def pending_count(self, chat_id: str | None) -> int:
        if not chat_id:
            return 0
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS count FROM pending WHERE chat_id = ?", (chat_id,)).fetchone()
            return int(row["count"] if row else 0)

    def receipt(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT receipt_json FROM web_upload_receipts WHERE asset_id = ?", (asset_id,)).fetchone()
        if not row:
            return None
        try:
            parsed = json.loads(str(row["receipt_json"]))
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            return None

    def save_receipt(self, asset_id: str, receipt: dict[str, Any]) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO web_upload_receipts(asset_id, receipt_json, created_at) VALUES(?, ?, ?) "
                "ON CONFLICT(asset_id) DO UPDATE SET receipt_json = excluded.receipt_json, created_at = excluded.created_at",
                (asset_id, json.dumps(receipt, ensure_ascii=False, separators=(",", ":")), time.time()),
            )
            conn.execute(
                "DELETE FROM web_upload_receipts WHERE created_at < ?",
                (time.time() - 30 * 24 * 60 * 60,),
            )

    def upload_session(self, asset_id: str) -> dict[str, Any] | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM upload_sessions WHERE asset_id = ?", (asset_id,)).fetchone()
        return dict(row) if row else None

    def save_upload_session(self, session: dict[str, Any]) -> None:
        now = time.time()
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO upload_sessions(
                  asset_id, content_hash, file_id, file_name, size_bytes, part_size, total_parts, next_part, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(asset_id) DO UPDATE SET
                  content_hash = excluded.content_hash,
                  file_id = excluded.file_id,
                  file_name = excluded.file_name,
                  size_bytes = excluded.size_bytes,
                  part_size = excluded.part_size,
                  total_parts = excluded.total_parts,
                  next_part = excluded.next_part,
                  created_at = excluded.created_at,
                  updated_at = excluded.updated_at""",
                (
                    session["asset_id"], session["content_hash"], int(session["file_id"]), session["file_name"],
                    int(session["size_bytes"]), int(session["part_size"]), int(session["total_parts"]), int(session["next_part"]),
                    float(session.get("created_at") or now), now,
                ),
            )
            conn.execute("DELETE FROM upload_sessions WHERE updated_at < ?", (now - 2 * 24 * 60 * 60,))

    def advance_upload_session(self, asset_id: str, next_part: int) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE upload_sessions SET next_part = ?, updated_at = ? WHERE asset_id = ?",
                (int(next_part), time.time(), asset_id),
            )

    def delete_upload_session(self, asset_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM upload_sessions WHERE asset_id = ?", (asset_id,))


class TelegramEngine:
    def __init__(self, runtime_root: Path) -> None:
        api_id, api_hash = _credentials()
        self.runtime_root = runtime_root
        self.state = BridgeState(runtime_root / "bridge-state.sqlite3")
        self.session_base = runtime_root / "telegram-storage"
        self.client = TelegramClient(str(self.session_base), api_id, api_hash, auto_reconnect=True, connection_retries=5, retry_delay=2)
        self.entity: Any | None = None
        self.chat_id: str | None = self.state.get_meta("storage_chat_id")
        self.chat_title: str | None = self.state.get_meta("storage_chat_title")
        self.connection_status = "disconnected"
        self.authorized = False
        self.last_error: str | None = None
        self.last_sync_at: str | None = self.state.get_meta("last_sync_at")
        self.auth_step: str | None = None
        self._phone: str | None = None
        self._phone_code_hash: str | None = None
        self._event_registered = False
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        try:
            await self.client.connect()
            if await self.client.is_user_authorized():
                self.authorized = True
                await self._after_authorized()
            else:
                self.authorized = False
                self.connection_status = "auth_required"
                self.auth_step = "phone"
        except (AuthKeyUnregisteredError, UserDeactivatedBanError):
            self.authorized = False
            self.connection_status = "auth_required"
            self.auth_step = "phone"
        except Exception as exc:
            self.connection_status = "error"
            self.last_error = self._public_error(exc, "NETWORK_ERROR")

    async def stop(self) -> None:
        try:
            await self.client.disconnect()
        except Exception:
            pass

    @staticmethod
    def _public_error(exc: Exception, fallback: str) -> str:
        if isinstance(exc, FloodWaitError):
            return f"FLOOD_WAIT:{max(1, int(exc.seconds))}"
        name = exc.__class__.__name__.upper()
        if "AUTH" in name or "SESSION" in name:
            return "SESSION_REVOKED"
        if "TIMEOUT" in name or "CONNECTION" in name or "NETWORK" in name:
            return "NETWORK_ERROR"
        return fallback

    async def _after_authorized(self) -> None:
        self.authorized = True
        self.auth_step = None
        await self.resolve_storage_chat()
        await self.catch_up()
        self.connection_status = "connected"
        self.last_error = None

    async def resolve_storage_chat(self) -> dict[str, Any]:
        if not await self.client.is_user_authorized():
            raise RuntimeError("AUTH_REQUIRED")
        entity = None
        candidates: list[Any] = []
        for candidate in [self.chat_id, INITIAL_CHAT_ID]:
            if not candidate:
                continue
            try:
                entity = await self.client.get_entity(int(candidate))
                candidates.append(entity)
                if getattr(entity, "title", None) == EXPECTED_CHAT_TITLE:
                    break
                entity = None
            except Exception:
                entity = None
        if entity is None:
            async for dialog in self.client.iter_dialogs():
                if (dialog.name or "").strip() == EXPECTED_CHAT_TITLE:
                    entity = dialog.entity
                    break
        if entity is None:
            self.connection_status = "error"
            self.last_error = "CHAT_NOT_FOUND"
            raise RuntimeError("CHAT_NOT_FOUND")
        title = str(getattr(entity, "title", "") or "")
        if title != EXPECTED_CHAT_TITLE:
            self.connection_status = "error"
            self.last_error = "CHAT_TITLE_MISMATCH"
            raise RuntimeError("CHAT_TITLE_MISMATCH")

        try:
            await self.client.get_messages(entity, limit=1)
        except Exception as exc:
            self.connection_status = "error"
            self.last_error = "CHAT_ACCESS_DENIED"
            raise RuntimeError("CHAT_ACCESS_DENIED") from exc

        can_send = True
        try:
            me = await self.client.get_me()
            permissions = await self.client.get_permissions(entity, me)
            banned = getattr(permissions, "banned_rights", None)
            if banned is not None and bool(getattr(banned, "send_messages", False)):
                can_send = False
            if bool(getattr(entity, "broadcast", False)) and not bool(getattr(permissions, "is_admin", False) or getattr(permissions, "is_creator", False)):
                can_send = False
        except Exception:
            # Sending is finally verified by the first actual upload. Resolution still proves read access.
            can_send = not bool(getattr(entity, "broadcast", False))
        if not can_send:
            self.connection_status = "error"
            self.last_error = "CHAT_ACCESS_DENIED"
            raise RuntimeError("CHAT_ACCESS_DENIED")

        canonical = str(utils.get_peer_id(entity))
        self.entity = entity
        self.chat_id = canonical
        self.chat_title = title
        self.state.set_meta("storage_chat_id", canonical)
        self.state.set_meta("storage_chat_title", title)
        if self._event_registered:
            self.client.remove_event_handler(self._on_new_message)
        self.client.add_event_handler(self._on_new_message, events.NewMessage(chats=entity))
        self._event_registered = True
        return {"chatId": canonical, "chatTitle": title, "canRead": True, "canSend": True}

    async def _on_new_message(self, event: Any) -> None:
        message = getattr(event, "message", None)
        if message is None or self.chat_id is None:
            return
        try:
            message_id = int(message.id)
            metadata = self._message_metadata(message)
            if metadata:
                self.state.add_pending(metadata)
            self.state.advance_checkpoint(message_id)
        except Exception:
            # Listener failures are recovered by history catch-up on the next sync/restart.
            pass

    def _message_metadata(self, message: Any) -> dict[str, Any] | None:
        if self.chat_id is None or getattr(message, "file", None) is None:
            return None
        file = message.file
        document = getattr(message, "document", None)
        photo = getattr(message, "photo", None)
        media_id = getattr(document, "id", None) or getattr(photo, "id", None)
        mime_type = str(getattr(file, "mime_type", None) or "application/octet-stream")
        name = str(getattr(file, "name", None) or "")
        if not name:
            extension = mimetypes.guess_extension(mime_type) or ""
            kind = "photo" if photo is not None else "video" if mime_type.startswith("video/") else "file"
            name = f"telegram-{kind}-{int(message.id)}{extension}"
        media_type = "photo" if photo is not None else "video" if mime_type.startswith("video/") else "file"
        date = getattr(message, "date", None)
        taken_at = date.isoformat().replace("+00:00", "Z") if date else _iso_now()
        result: dict[str, Any] = {
            "chatId": self.chat_id,
            "messageId": int(message.id),
            "mediaId": str(media_id) if media_id is not None else None,
            "fileName": name,
            "mimeType": mime_type,
            "sizeBytes": int(getattr(file, "size", 0) or 0),
            "mediaType": media_type,
            "takenAt": taken_at,
        }
        width = getattr(file, "width", None)
        height = getattr(file, "height", None)
        duration = getattr(file, "duration", None)
        if isinstance(width, int) and width > 0:
            result["width"] = width
        if isinstance(height, int) and height > 0:
            result["height"] = height
        if isinstance(duration, (int, float)) and duration >= 0:
            result["durationMs"] = int(float(duration) * 1000)
        return result

    async def catch_up(self) -> dict[str, Any]:
        if self.entity is None:
            await self.resolve_storage_chat()
        assert self.entity is not None
        async with self._lock:
            self.connection_status = "syncing"
            checkpoint = self.state.checkpoint()
            scanned = 0
            queued = 0
            try:
                async for message in self.client.iter_messages(self.entity, min_id=checkpoint, reverse=True):
                    scanned += 1
                    metadata = self._message_metadata(message)
                    if metadata:
                        before = self.state.pending_count(self.chat_id)
                        self.state.add_pending(metadata)
                        after = self.state.pending_count(self.chat_id)
                        if after > before:
                            queued += 1
                    self.state.advance_checkpoint(int(message.id))
                self.last_sync_at = _iso_now()
                self.state.set_meta("last_sync_at", self.last_sync_at)
                self.connection_status = "connected"
                self.last_error = None
                return {"scanned": scanned, "queued": queued, "checkpoint": self.state.checkpoint()}
            except FloodWaitError as exc:
                self.connection_status = "error"
                self.last_error = f"FLOOD_WAIT:{max(1, int(exc.seconds))}"
                raise
            except Exception as exc:
                self.connection_status = "error"
                self.last_error = self._public_error(exc, "SYNC_FAILED")
                raise

    async def send_code(self, phone: str) -> dict[str, Any]:
        phone = phone.strip()
        if not phone or len(phone) > 40:
            raise RuntimeError("PHONE_INVALID")
        if not self.client.is_connected():
            await self.client.connect()
        result = await self.client.send_code_request(phone)
        self._phone = phone
        self._phone_code_hash = result.phone_code_hash
        self.connection_status = "auth_required"
        self.auth_step = "code"
        return {"ok": True, "authStep": "code"}

    async def confirm_code(self, code: str) -> dict[str, Any]:
        if not self._phone or not self._phone_code_hash:
            raise RuntimeError("AUTH_CODE_NOT_REQUESTED")
        code = code.strip()
        if not code or len(code) > 16:
            raise RuntimeError("AUTH_CODE_INVALID")
        try:
            await self.client.sign_in(self._phone, code=code, phone_code_hash=self._phone_code_hash)
        except SessionPasswordNeededError:
            self.connection_status = "auth_required"
            self.auth_step = "password"
            return {"ok": True, "authStep": "password", "passwordRequired": True}
        except PhoneCodeInvalidError as exc:
            raise RuntimeError("AUTH_CODE_INVALID") from exc
        except PhoneCodeExpiredError as exc:
            self.auth_step = "phone"
            raise RuntimeError("AUTH_CODE_EXPIRED") from exc
        self._phone = None
        self._phone_code_hash = None
        await self._after_authorized()
        return {"ok": True, "authStep": None, "status": self.status()}

    async def confirm_password(self, password: str) -> dict[str, Any]:
        if self.auth_step != "password":
            raise RuntimeError("AUTH_PASSWORD_NOT_REQUESTED")
        if not password or len(password) > 512:
            raise RuntimeError("AUTH_PASSWORD_INVALID")
        try:
            await self.client.sign_in(password=password)
        except PasswordHashInvalidError as exc:
            raise RuntimeError("AUTH_PASSWORD_INVALID") from exc
        self._phone = None
        self._phone_code_hash = None
        await self._after_authorized()
        return {"ok": True, "authStep": None, "status": self.status()}

    async def reauthorize(self) -> dict[str, Any]:
        try:
            if await self.client.is_user_authorized():
                await self.client.log_out()
        except Exception:
            await self.client.disconnect()
        self.entity = None
        self.chat_id = None
        self.chat_title = None
        self.authorized = False
        self.connection_status = "auth_required"
        self.auth_step = "phone"
        self._phone = None
        self._phone_code_hash = None
        return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "ok": True,
            "service": SERVICE_NAME,
            "connectionStatus": self.connection_status,
            "authorized": self.authorized,
            "authStep": self.auth_step,
            "storageChatId": self.chat_id,
            "storageChatTitle": self.chat_title,
            "lastSyncAt": self.last_sync_at,
            "lastError": self.last_error,
            "checkpoint": self.state.checkpoint(),
            "pendingCount": self.state.pending_count(self.chat_id),
            "capabilities": {
                "cryptg": CRYPTG_AVAILABLE,
                "resumableLargeUploads": True,
                "rangeOriginalDownloads": True,
                "streamingOriginalDownloads": True,
            },
        }

    def _matching_upload_session(self, asset_id: str, file_name: str, size_bytes: int, content_hash: str) -> dict[str, Any] | None:
        session = self.state.upload_session(asset_id)
        if not session:
            return None
        valid = (
            str(session.get("content_hash") or "") == content_hash
            and str(session.get("file_name") or "") == file_name
            and int(session.get("size_bytes") or -1) == size_bytes
            and int(session.get("part_size") or 0) == TELEGRAM_PART_SIZE_BYTES
            and int(session.get("total_parts") or 0) == math.ceil(size_bytes / TELEGRAM_PART_SIZE_BYTES)
            and 0 <= int(session.get("next_part") or 0) <= int(session.get("total_parts") or 0)
            and time.time() - float(session.get("created_at") or 0) < UPLOAD_SESSION_TTL_SECONDS
        )
        if valid:
            return session
        self.state.delete_upload_session(asset_id)
        return None

    async def _upload_large_resumable(
        self,
        asset_id: str,
        file_path: Path,
        file_name: str,
        size_bytes: int,
        content_hash: str,
        *,
        force_new: bool = False,
    ) -> tuple[types.InputFileBig, int]:
        if force_new:
            self.state.delete_upload_session(asset_id)
        session = self._matching_upload_session(asset_id, file_name, size_bytes, content_hash)
        total_parts = math.ceil(size_bytes / TELEGRAM_PART_SIZE_BYTES)
        if session is None:
            session = {
                "asset_id": asset_id,
                "content_hash": content_hash,
                "file_id": helpers.generate_random_long(),
                "file_name": file_name,
                "size_bytes": size_bytes,
                "part_size": TELEGRAM_PART_SIZE_BYTES,
                "total_parts": total_parts,
                "next_part": 0,
                "created_at": time.time(),
            }
            self.state.save_upload_session(session)
        next_part = int(session["next_part"])
        resumed_bytes = min(size_bytes, next_part * TELEGRAM_PART_SIZE_BYTES)
        file_id = int(session["file_id"])
        with file_path.open("rb") as source:
            source.seek(next_part * TELEGRAM_PART_SIZE_BYTES)
            for part_index in range(next_part, total_parts):
                part = source.read(TELEGRAM_PART_SIZE_BYTES)
                if not part:
                    raise RuntimeError("UPLOAD_BODY_TRUNCATED")
                result = await self.client(functions.upload.SaveBigFilePartRequest(file_id, part_index, total_parts, part))
                if not result:
                    raise RuntimeError(f"UPLOAD_PART_FAILED:{part_index}")
                self.state.advance_upload_session(asset_id, part_index + 1)
        return types.InputFileBig(file_id, total_parts, file_name), resumed_bytes

    @staticmethod
    def _is_upload_part_error(exc: Exception) -> bool:
        marker = f"{exc.__class__.__name__}:{exc}".upper()
        return "FILEPART" in marker or "FILE_PART" in marker

    async def upload(self, asset_id: str, file_path: Path, file_name: str, mime_type: str, size_bytes: int, content_hash: str) -> dict[str, Any]:
        existing = self.state.receipt(asset_id)
        if existing:
            return existing
        if self.entity is None:
            await self.resolve_storage_chat()
        assert self.entity is not None and self.chat_id is not None
        started = time.perf_counter()
        resumed_bytes = 0
        try:
            if size_bytes > BIG_UPLOAD_THRESHOLD_BYTES:
                uploaded, resumed_bytes = await self._upload_large_resumable(asset_id, file_path, file_name, size_bytes, content_hash)
            else:
                self.state.delete_upload_session(asset_id)
                uploaded = await self.client.upload_file(str(file_path), file_size=size_bytes, file_name=file_name, part_size_kb=512)

            try:
                message = await self.client.send_file(
                    self.entity,
                    uploaded,
                    force_document=not mime_type.startswith("video/mp4"),
                    mime_type=mime_type,
                    file_size=size_bytes,
                    supports_streaming=mime_type.startswith("video/mp4"),
                )
            except Exception as exc:
                if size_bytes <= BIG_UPLOAD_THRESHOLD_BYTES or not self._is_upload_part_error(exc):
                    raise
                uploaded, resumed_bytes = await self._upload_large_resumable(
                    asset_id, file_path, file_name, size_bytes, content_hash, force_new=True,
                )
                message = await self.client.send_file(
                    self.entity,
                    uploaded,
                    force_document=not mime_type.startswith("video/mp4"),
                    mime_type=mime_type,
                    file_size=size_bytes,
                    supports_streaming=mime_type.startswith("video/mp4"),
                )

            metadata = self._message_metadata(message)
            if not metadata:
                raise RuntimeError("UPLOAD_RESPONSE_WITHOUT_MEDIA")
            receipt = {
                "backend": "telegram_user_group",
                "chatId": self.chat_id,
                "messageId": int(message.id),
                "mediaId": metadata.get("mediaId"),
                "sizeBytes": size_bytes,
                "fileName": file_name,
                "mimeType": mime_type,
                "resumedBytes": resumed_bytes,
                "telegramUploadMs": max(0, int((time.perf_counter() - started) * 1000)),
            }
            self.state.save_receipt(asset_id, receipt)
            self.state.delete_upload_session(asset_id)
            self.state.remove_pending(self.chat_id, [int(message.id)])
            self.state.advance_checkpoint(int(message.id))
            return receipt
        except FloodWaitError:
            raise
        except Exception as exc:
            raise RuntimeError(self._public_error(exc, "UPLOAD_FAILED")) from exc

    async def delete_message(self, chat_id: str, message_id: int) -> dict[str, Any]:
        if self.entity is None:
            await self.resolve_storage_chat()
        if chat_id != self.chat_id:
            raise RuntimeError("CHAT_ACCESS_DENIED")
        assert self.entity is not None
        try:
            await self.client.delete_messages(self.entity, [message_id], revoke=True)
            self.state.remove_pending(chat_id, [message_id])
            return {"ok": True, "deleted": True}
        except FloodWaitError:
            raise
        except Exception as exc:
            raise RuntimeError(self._public_error(exc, "DELETE_FAILED")) from exc

    async def download_info(self, chat_id: str, message_id: int) -> tuple[Any, str, str, int]:
        if self.entity is None:
            await self.resolve_storage_chat()
        if chat_id != self.chat_id:
            raise RuntimeError("CHAT_ACCESS_DENIED")
        assert self.entity is not None
        message = await self.client.get_messages(self.entity, ids=message_id)
        if not message or getattr(message, "file", None) is None:
            raise RuntimeError("MEDIA_NOT_FOUND")
        metadata = self._message_metadata(message) or {}
        original_name = str(metadata.get("fileName") or f"telegram-{message_id}")
        mime_type = str(metadata.get("mimeType") or "application/octet-stream")
        expected_size = int(metadata.get("sizeBytes") or 0)
        if expected_size <= 0:
            raise RuntimeError("DOWNLOAD_SIZE_UNKNOWN")
        return message, original_name, mime_type, expected_size

    async def stream_original(
        self,
        message: Any,
        start: int,
        length: int,
        output: queue.Queue[Any],
        stop: threading.Event,
    ) -> None:
        remaining = length
        try:
            async for chunk in self.client.iter_download(
                message.media,
                offset=start,
                chunk_size=DOWNLOAD_STREAM_CHUNK_BYTES,
                request_size=DOWNLOAD_STREAM_CHUNK_BYTES,
            ):
                if stop.is_set() or remaining <= 0:
                    break
                payload = bytes(chunk[:remaining])
                if not payload:
                    break
                while not stop.is_set():
                    try:
                        output.put_nowait(payload)
                        break
                    except queue.Full:
                        await asyncio.sleep(0.01)
                remaining -= len(payload)
                if remaining <= 0:
                    break
            if remaining > 0 and not stop.is_set():
                raise RuntimeError("DOWNLOAD_BODY_TRUNCATED")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            while not stop.is_set():
                try:
                    output.put_nowait(exc)
                    break
                except queue.Full:
                    await asyncio.sleep(0.01)
        finally:
            while not stop.is_set():
                try:
                    output.put_nowait(None)
                    break
                except queue.Full:
                    await asyncio.sleep(0.01)

    async def download_to_path(self, chat_id: str, message_id: int, variant: str) -> tuple[Path, str, str, int]:
        message, original_name, mime_type, expected_size = await self.download_info(chat_id, message_id)
        cache_root = self.runtime_root / "cache"
        cache_root.mkdir(parents=True, exist_ok=True)
        safe_variant = "preview" if variant == "preview" else "original"
        suffix = Path(original_name).suffix if safe_variant == "original" else ".preview"
        final_path = cache_root / f"{chat_id.replace('-', 'm')}_{message_id}_{safe_variant}{suffix}"
        if final_path.exists() and final_path.stat().st_size > 0:
            if safe_variant == "original" and expected_size and final_path.stat().st_size != expected_size:
                final_path.unlink(missing_ok=True)
            else:
                return final_path, original_name, mime_type, int(final_path.stat().st_size)
        part_path = final_path.with_name(final_path.name + ".part")
        part_path.unlink(missing_ok=True)
        try:
            downloaded = await self.client.download_media(message, file=str(part_path), thumb=-1 if safe_variant == "preview" else None)
            if not downloaded or not part_path.exists():
                raise RuntimeError("PREVIEW_NOT_AVAILABLE" if safe_variant == "preview" else "DOWNLOAD_FAILED")
            actual = int(part_path.stat().st_size)
            if safe_variant == "original" and expected_size and actual != expected_size:
                raise RuntimeError("DOWNLOAD_SIZE_MISMATCH")
            os.replace(part_path, final_path)
            if safe_variant == "preview":
                mime_type = mimetypes.guess_type(str(final_path))[0] or "image/jpeg"
            return final_path, original_name, mime_type, actual
        except Exception:
            part_path.unlink(missing_ok=True)
            raise


class BridgeHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], engine: TelegramEngine, loop: asyncio.AbstractEventLoop, secret: str):
        super().__init__(address, handler)
        self.engine = engine
        self.loop = loop
        self.secret = secret


class Handler(BaseHTTPRequestHandler):
    server_version = "PrivateArchiveTelegramBridge/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def app(self) -> BridgeHttpServer:
        return self.server  # type: ignore[return-value]

    def log_message(self, _format: str, *_args: Any) -> None:
        # Never log request paths/headers: auth codes and file names may be sensitive.
        return

    def _authorized(self) -> bool:
        supplied = self.headers.get("X-Private-Archive-Bridge", "")
        return bool(self.app.secret) and hmac.compare_digest(supplied, self.app.secret)

    def _json(self, status: int, value: Any) -> None:
        body = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise RuntimeError("INVALID_CONTENT_LENGTH") from exc
        if length < 0 or length > MAX_JSON_BODY:
            raise RuntimeError("JSON_BODY_TOO_LARGE")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise RuntimeError("INVALID_JSON") from exc
        if not isinstance(parsed, dict):
            raise RuntimeError("INVALID_JSON")
        return parsed

    def _future(self, coro: Any, timeout: float = 300.0) -> Any:
        future = asyncio.run_coroutine_threadsafe(coro, self.app.loop)
        return future.result(timeout=timeout)

    @staticmethod
    def _status_for_error(code: str) -> int:
        if code.startswith("AUTH_") or code == "SESSION_REVOKED":
            return HTTPStatus.UNAUTHORIZED
        if code in {"CHAT_NOT_FOUND", "MEDIA_NOT_FOUND", "PREVIEW_NOT_AVAILABLE"}:
            return HTTPStatus.NOT_FOUND
        if code in {"CHAT_ACCESS_DENIED", "CHAT_TITLE_MISMATCH"}:
            return HTTPStatus.FORBIDDEN
        if code.startswith("FLOOD_WAIT"):
            return HTTPStatus.TOO_MANY_REQUESTS
        if code.startswith("INVALID_") or code in {"PHONE_INVALID", "DOWNLOAD_SIZE_MISMATCH"}:
            return HTTPStatus.BAD_REQUEST
        return HTTPStatus.BAD_GATEWAY

    def _error(self, exc: Exception) -> None:
        code = str(exc) or "BRIDGE_FAILED"
        if isinstance(exc, FloodWaitError):
            code = f"FLOOD_WAIT:{max(1, int(exc.seconds))}"
        self._json(self._status_for_error(code), {"ok": False, "error": code})

    def _guard(self) -> bool:
        if self.client_address[0] not in {"127.0.0.1", "::1"}:
            self._json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "LOOPBACK_ONLY"})
            return False
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "BRIDGE_AUTH_REQUIRED"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._guard():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/v1/status":
                self._json(200, self.app.engine.status())
                return
            if parsed.path == "/v1/pending":
                query = parse_qs(parsed.query)
                limit = max(1, min(100, int(query.get("limit", ["50"])[0])))
                chat_id = self.app.engine.chat_id
                items = self.app.engine.state.pending(chat_id, limit) if chat_id else []
                self._json(200, {"ok": True, "items": items, "pendingCount": self.app.engine.state.pending_count(chat_id)})
                return
            if parsed.path == "/v1/file":
                self._serve_file(parsed)
                return
            self._json(404, {"ok": False, "error": "NOT_FOUND"})
        except Exception as exc:
            self._error(exc)

    def do_POST(self) -> None:
        if not self._guard():
            return
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/v1/auth/send-code":
                body = self._read_json()
                self._json(200, self._future(self.app.engine.send_code(str(body.get("phone", "")))))
                return
            if parsed.path == "/v1/auth/confirm":
                body = self._read_json()
                self._json(200, self._future(self.app.engine.confirm_code(str(body.get("code", "")))))
                return
            if parsed.path == "/v1/auth/password":
                body = self._read_json()
                self._json(200, self._future(self.app.engine.confirm_password(str(body.get("password", "")))))
                return
            if parsed.path == "/v1/auth/reauthorize":
                self._json(200, self._future(self.app.engine.reauthorize()))
                return
            if parsed.path == "/v1/sync":
                result = self._future(self.app.engine.catch_up(), timeout=600.0)
                self._json(200, {"ok": True, **result, "status": self.app.engine.status()})
                return
            if parsed.path == "/v1/ack":
                body = self._read_json()
                raw_ids = body.get("messageIds")
                if not isinstance(raw_ids, list) or len(raw_ids) > 100:
                    raise RuntimeError("INVALID_ACK")
                ids = [int(value) for value in raw_ids if isinstance(value, int) and value > 0]
                chat_id = self.app.engine.chat_id
                removed = self.app.engine.state.remove_pending(chat_id, ids) if chat_id else 0
                self._json(200, {"ok": True, "removed": removed})
                return
            if parsed.path == "/v1/delete":
                body = self._read_json()
                chat_id = str(body.get("chatId", ""))
                message_id = int(body.get("messageId", 0))
                self._json(200, self._future(self.app.engine.delete_message(chat_id, message_id)))
                return
            self._json(404, {"ok": False, "error": "NOT_FOUND"})
        except Exception as exc:
            self._error(exc)

    def do_PUT(self) -> None:
        if not self._guard():
            return
        parsed = urlparse(self.path)
        if parsed.path != "/v1/upload":
            self._json(404, {"ok": False, "error": "NOT_FOUND"})
            return
        try:
            query = parse_qs(parsed.query)
            asset_id = (query.get("assetId", [""])[0] or "").strip()
            file_name = (query.get("fileName", [""])[0] or "").strip()
            mime_type = (query.get("mimeType", ["application/octet-stream"])[0] or "application/octet-stream").strip()
            expected_hash = (query.get("sha256", [""])[0] or "").strip().lower()
            if not re.fullmatch(r"[0-9a-fA-F-]{8,80}", asset_id):
                raise RuntimeError("INVALID_ASSET_ID")
            if not file_name or len(file_name) > 255 or "\x00" in file_name:
                raise RuntimeError("INVALID_FILE_NAME")
            if len(mime_type) > 160:
                raise RuntimeError("INVALID_MIME_TYPE")
            if expected_hash and not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
                raise RuntimeError("INVALID_CONTENT_HASH")
            existing = self.app.engine.state.receipt(asset_id)
            if existing:
                self._drain_request_body()
                self._json(200, {"ok": True, "receipt": existing, "alreadyUploaded": True})
                return
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError as exc:
                raise RuntimeError("INVALID_CONTENT_LENGTH") from exc
            if length < 0 or length > (1 << 63) - 1:
                raise RuntimeError("INVALID_CONTENT_LENGTH")
            uploads = self.app.engine.runtime_root / "uploads"
            uploads.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix="pa-upload-", suffix=".part", dir=str(uploads))
            os.close(fd)
            temp_path = Path(temp_name)
            digest = hashlib.sha256()
            remaining = length
            try:
                with temp_path.open("wb") as output:
                    while remaining:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise RuntimeError("UPLOAD_BODY_TRUNCATED")
                        output.write(chunk)
                        digest.update(chunk)
                        remaining -= len(chunk)
                actual_hash = digest.hexdigest()
                if expected_hash and not hmac.compare_digest(actual_hash, expected_hash):
                    raise RuntimeError("CONTENT_HASH_MISMATCH")
                receipt = self._future(
                    self.app.engine.upload(asset_id, temp_path, file_name, mime_type, length, actual_hash),
                    timeout=6 * 60 * 60,
                )
                self._json(201, {"ok": True, "receipt": receipt, "alreadyUploaded": False})
            finally:
                temp_path.unlink(missing_ok=True)
        except Exception as exc:
            self._error(exc)

    def _drain_request_body(self) -> None:
        try:
            remaining = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return
        while remaining > 0:
            chunk = self.rfile.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def _serve_file(self, parsed: Any) -> None:
        query = parse_qs(parsed.query)
        chat_id = str(query.get("chatId", [""])[0])
        message_id = int(query.get("messageId", ["0"])[0])
        variant = "preview" if query.get("variant", ["original"])[0] == "preview" else "original"
        message: Any | None = None
        path: Path | None = None
        if variant == "preview":
            path, original_name, mime_type, size = self._future(
                self.app.engine.download_to_path(chat_id, message_id, variant),
                timeout=6 * 60 * 60,
            )
        else:
            message, original_name, mime_type, size = self._future(
                self.app.engine.download_info(chat_id, message_id),
                timeout=300.0,
            )

        start = 0
        end = size - 1
        status = 200
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(size - 1, int(last)) if last else size - 1
            elif last:
                amount = min(size, int(last))
                start = size - amount
                end = size - 1
            if start < 0 or start >= size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.end_headers()
                return
            status = 206

        length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", mime_type)
        disposition = "inline" if variant == "preview" else "attachment"
        encoded_name = quote(original_name, safe="")
        self.send_header("Content-Disposition", f"{disposition}; filename*=UTF-8''{encoded_name}")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "private, max-age=3600" if variant == "preview" else "private, no-store")
        self.send_header("Content-Length", str(length))
        self.send_header("X-Private-Archive-Transfer-Mode", "preview-cache" if variant == "preview" else "telegram-stream")
        self.send_header("X-Private-Archive-Resume", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command == "HEAD":
            return

        if variant == "preview":
            assert path is not None
            with path.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            return

        assert message is not None
        output: queue.Queue[Any] = queue.Queue(maxsize=DOWNLOAD_STREAM_QUEUE_CHUNKS)
        stop = threading.Event()
        future = asyncio.run_coroutine_threadsafe(
            self.app.engine.stream_original(message, start, length, output, stop),
            self.app.loop,
        )
        try:
            while True:
                item = output.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                self.wfile.write(item)
        except Exception:
            stop.set()
            future.cancel()
            self.close_connection = True
            return
        finally:
            stop.set()
        try:
            future.result(timeout=2.0)
        except Exception:
            self.close_connection = True


def _run_async_loop(engine: TelegramEngine, ready: threading.Event) -> asyncio.AbstractEventLoop:
    loop = asyncio.new_event_loop()

    def runner() -> None:
        asyncio.set_event_loop(loop)
        loop.run_until_complete(engine.start())
        ready.set()
        loop.run_forever()
        loop.run_until_complete(engine.stop())
        loop.close()

    threading.Thread(target=runner, name="TelegramStorageAsync", daemon=True).start()
    return loop


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    if args.port < 1024 or args.port > 65535:
        return 2
    secret = os.environ.get("PRIVATE_ARCHIVE_BRIDGE_SECRET", "")
    if len(secret) < 32:
        return 3
    runtime_root = _runtime_root()
    _harden_runtime_directory(runtime_root)
    try:
        engine = TelegramEngine(runtime_root)
    except Exception:
        return 4
    ready = threading.Event()
    loop = _run_async_loop(engine, ready)
    ready.wait(timeout=20)
    try:
        server = BridgeHttpServer(("127.0.0.1", args.port), Handler, engine, loop, secret)
    except OSError:
        loop.call_soon_threadsafe(loop.stop)
        return 5

    def monitor_parent() -> None:
        if args.parent_pid <= 0:
            return
        while _parent_alive(args.parent_pid):
            time.sleep(2)
        server.shutdown()

    threading.Thread(target=monitor_parent, name="TelegramStorageParentWatch", daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
        loop.call_soon_threadsafe(loop.stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
