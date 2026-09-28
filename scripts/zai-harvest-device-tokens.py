#!/usr/bin/env python3
"""
Harvest Z.AI (chat.z.ai) device tokens into the pool used by the zai-web provider.

Why this exists
---------------
chat.z.ai gates its completion API behind an Aliyun CaptchaVerifyParam. Producing
that param needs a "deviceToken" minted by Aliyun FeiLin — an anti-bot script that
only runs inside a real browser engine (it touches `document` and `navigator`
heavily), so it cannot run in Node.

Both the device token and the resulting captcha param are SINGLE USE: one
completion consumes exactly one token. This script refills the pool in bulk.

Usage
-----
    python3 scripts/zai-harvest-device-tokens.py --token <JWT> [--count 50]

    # or read the JWT from the environment / a file
    ZAI_TOKEN=eyJ... python3 scripts/zai-harvest-device-tokens.py --count 50
    python3 scripts/zai-harvest-device-tokens.py --token-file ~/.zai-token --count 50

The token is the `token` value in chat.z.ai localStorage (DevTools -> Application
-> Local Storage -> chat.z.ai -> token).

Requires: pip install playwright && playwright install chromium
Output:   ~/.hermes/zai-device-tokens.json  (override with ZAI_DEVICE_TOKEN_POOL)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import time

DEFAULT_POOL = pathlib.Path.home() / ".hermes" / "zai-device-tokens.json"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
)


def resolve_pool_path() -> pathlib.Path:
    return pathlib.Path(os.environ.get("ZAI_DEVICE_TOKEN_POOL") or DEFAULT_POOL)


def resolve_lock_path() -> pathlib.Path:
    """Must match open-sse/lib/zaiDeviceToken.js: `<pool>.lock`."""
    return pathlib.Path(f"{resolve_pool_path()}.lock")


class PoolLock:
    """Same cross-process lock the JS executor uses, so a harvest can never
    race a take/return and silently drop the tokens written by the other side.

    O_CREAT|O_EXCL means exactly one winner per instant. A lock whose owner pid
    is gone, or older than LOCK_STALE_S, is reclaimed.
    """

    LOCK_STALE_S = 30.0
    WAIT_S = 3.0

    def __init__(self, path: pathlib.Path | None = None) -> None:
        self.path = path or resolve_lock_path()
        self.held = False

    @staticmethod
    def _alive(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        # A zombie answers signal 0 but is gone; a SIGKILLed server leaves one
        # behind, which would otherwise hold the lock for the whole stale window.
        try:
            stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
            if stat[stat.rindex(")") + 2] == "Z":
                return False
        except Exception:
            pass
        return True

    def __enter__(self) -> "PoolLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.WAIT_S
        while time.monotonic() < deadline:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w") as fh:
                    json.dump({"pid": os.getpid(), "at": time.time() * 1000}, fh)
                self.held = True
                return self
            except FileExistsError:
                try:
                    info = json.loads(self.path.read_text())
                    age = time.time() * 1000 - float(info.get("at", 0))
                    if not self._alive(int(info.get("pid", 0))) or age > self.LOCK_STALE_S * 1000:
                        self.path.unlink(missing_ok=True)
                        continue
                except Exception:
                    pass
                time.sleep(0.002)
        # Timed out: proceed unlocked rather than failing the harvest outright.
        return self

    def __exit__(self, *exc: object) -> None:
        if self.held:
            try:
                self.path.unlink(missing_ok=True)
            except Exception:
                pass


def load_pool(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text())
        tokens = [t for t in data.get("tokens", []) if isinstance(t, str) and t]
        return {"tokens": tokens, "updatedAt": data.get("updatedAt", 0)}
    except Exception:
        return {"tokens": [], "updatedAt": 0}


def save_pool(path: pathlib.Path, pool: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Temp file + rename, matching open-sse/lib/zaiDeviceToken.js: rename is
    # atomic, so a reader never parses a half-written pool.
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps({**pool, "updatedAt": int(time.time() * 1000)}, indent=2))
    os.replace(tmp, path)


def find_chromium() -> str | None:
    """Playwright sometimes ships a newer revision than the installed binary."""
    cache = pathlib.Path.home() / ".cache" / "ms-playwright"
    if not cache.is_dir():
        return None
    candidates = sorted(cache.glob("chromium-*/chrome-linux*/chrome"), reverse=True)
    return str(candidates[0]) if candidates else None


def harvest(token: str, count: int, headed: bool, timeout_s: int) -> list[str]:
    from playwright.sync_api import sync_playwright

    exe = find_chromium()
    with sync_playwright() as pw:
        launch_kwargs: dict = {
            "headless": not headed,
            "args": ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        }
        if exe:
            launch_kwargs["executable_path"] = exe
        browser = pw.chromium.launch(**launch_kwargs)
        try:
            ctx = browser.new_context(
                user_agent=UA,
                viewport={"width": 1680, "height": 1050},
                locale="en-US",
                timezone_id="Asia/Jakarta",
            )
            page = ctx.new_page()

            page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=60_000)
            time.sleep(3)
            page.evaluate("(t) => { localStorage.setItem('token', t); }", token)
            page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=60_000)
            time.sleep(6)

            # FeiLin (which defines window.z_um.getToken) only loads after the
            # first send, so trigger one message.
            page.click("#chat-input")
            time.sleep(0.3)
            page.keyboard.type("Reply with exactly the single word PONG", delay=55)
            time.sleep(0.5)
            page.click("#send-message-button")

            ready = False
            for _ in range(timeout_s):
                time.sleep(1)
                if page.evaluate(
                    "() => typeof window.z_um === 'object' && window.z_um "
                    "&& typeof window.z_um.getToken === 'function'"
                ):
                    ready = True
                    break
            if not ready:
                raise RuntimeError(
                    "window.z_um.getToken never appeared — FeiLin failed to load. "
                    "Is the token valid, and is Chromium (not Firefox) being used?"
                )

            raw = page.evaluate(
                """async (n) => {
                    const out = [];
                    for (let i = 0; i < n; i++) {
                        let t = window.z_um.getToken();
                        if (t && typeof t.then === 'function') t = await t;
                        out.push(t);
                    }
                    return out;
                }""",
                count,
            )
        finally:
            browser.close()

    seen: set[str] = set()
    tokens: list[str] = []
    for t in raw or []:
        s = str(t) if t is not None else ""
        if s and s not in seen:
            seen.add(s)
            tokens.append(s)
    return tokens


def main() -> int:
    ap = argparse.ArgumentParser(description="Harvest Z.AI device tokens for the zai-web provider.")
    ap.add_argument("--token", help="chat.z.ai localStorage `token` (JWT)")
    ap.add_argument("--token-file", help="file containing the JWT")
    ap.add_argument("--count", type=int, default=50, help="tokens to harvest (default 50)")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    ap.add_argument("--timeout", type=int, default=45, help="seconds to wait for FeiLin (default 45)")
    args = ap.parse_args()

    token = (args.token or "").strip()
    if not token and args.token_file:
        token = pathlib.Path(args.token_file).expanduser().read_text().strip()
    if not token:
        token = (os.environ.get("ZAI_TOKEN") or "").strip()
    if not token:
        print("ERROR: no token. Pass --token, --token-file, or set ZAI_TOKEN.", file=sys.stderr)
        return 2

    pool_path = resolve_pool_path()

    print(f"Harvesting {args.count} device tokens...")
    try:
        fresh = harvest(token, args.count, args.headed, args.timeout)
    except Exception as exc:
        print(f"ERROR: harvest failed: {exc}", file=sys.stderr)
        return 1

    if not fresh:
        print("ERROR: harvested 0 tokens.", file=sys.stderr)
        return 1

    # Re-read the pool AFTER harvesting. The harvest takes tens of seconds, and
    # the executor is consuming tokens the whole time — merging into a snapshot
    # taken before the browser work would resurrect already-spent tokens (and
    # hand one device token to two requests). Single-use must stay single-use.
    # The lock keeps this read-modify-write from racing takeDeviceToken().
    with PoolLock():
        current = load_pool(pool_path)
        before_count = len(current["tokens"])
        merged = current["tokens"] + [t for t in fresh if t not in current["tokens"]]
        save_pool(pool_path, {"tokens": merged})
    print(f"Harvested {len(fresh)} new tokens.")
    print(f"Pool: {before_count} -> {len(merged)}  ({pool_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
