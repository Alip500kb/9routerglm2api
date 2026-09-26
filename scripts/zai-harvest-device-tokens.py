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


def load_pool(path: pathlib.Path) -> dict:
    try:
        data = json.loads(path.read_text())
        tokens = [t for t in data.get("tokens", []) if isinstance(t, str) and t]
        return {"tokens": tokens, "updatedAt": data.get("updatedAt", 0)}
    except Exception:
        return {"tokens": [], "updatedAt": 0}


def save_pool(path: pathlib.Path, pool: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**pool, "updatedAt": int(time.time() * 1000)}, indent=2))


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
    before = load_pool(pool_path)

    print(f"Harvesting {args.count} device tokens...")
    try:
        fresh = harvest(token, args.count, args.headed, args.timeout)
    except Exception as exc:
        print(f"ERROR: harvest failed: {exc}", file=sys.stderr)
        return 1

    if not fresh:
        print("ERROR: harvested 0 tokens.", file=sys.stderr)
        return 1

    merged = before["tokens"] + [t for t in fresh if t not in before["tokens"]]
    save_pool(pool_path, {"tokens": merged})
    print(f"Harvested {len(fresh)} new tokens.")
    print(f"Pool: {len(before['tokens'])} -> {len(merged)}  ({pool_path})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
