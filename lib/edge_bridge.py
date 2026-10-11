#!/usr/bin/env python3
"""edge-tts bridge that survives Microsoft's endpoint migration.

Microsoft moved Edge's Read Aloud service from

    wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1

to

    wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1

and regional backend pools started answering the old address with 403 while the
voice list kept working, so the endpoint moving is invisible from the outside
except that synthesis fails. Edge 155 reaches the new address with a newer DRM
token, but the token the library already generates is still accepted there, so
switching the address is enough.

This lives here rather than as an edit to the installed package so that
`pip install -U edge-tts` cannot silently undo it. Once upstream ships the
migration the fallback below simply stops being used.

Endpoints are tried in order and the first success wins; every endpoint that
failed is reported on stderr so a genuine outage is distinguishable from a
migration.
"""

import argparse
import asyncio
import os
import sys

import edge_tts
import edge_tts.communicate as cm
from edge_tts.constants import TRUSTED_CLIENT_TOKEN

# The address Edge itself uses today, and whatever the installed version ships.
# Order matters: the migrated host first, the installed default as the fallback.
ENDPOINTS = [
    (
        "v2",
        f"wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
        f"?Ocp-Apim-Subscription-Key={TRUSTED_CLIENT_TOKEN}",
    ),
    ("installed", cm.WSS_URL),
]


async def synthesize(text, voice, rate, pitch, out_file):
    failures = []
    for name, url in ENDPOINTS:
        cm.WSS_URL = url
        try:
            audio = bytearray()
            communicator = edge_tts.Communicate(
                text=text, voice=voice, rate=rate, pitch=pitch
            )
            async for chunk in communicator.stream():
                if chunk["type"] == "audio":
                    audio.extend(chunk["data"])
            if not audio:
                failures.append(f"{name}: empty response")
                continue
            with open(out_file, "wb") as handle:
                handle.write(audio)
            for note in failures:
                print(f"edge_bridge: {note}", file=sys.stderr)
            print(f"edge_bridge: used {name} endpoint, {len(audio)} bytes", file=sys.stderr)
            return 0
        except Exception as exc:  # noqa: BLE001 - every failure is worth trying past
            failures.append(f"{name}: {type(exc).__name__}: {str(exc)[:200]}")
    for note in failures:
        print(f"edge_bridge: {note}", file=sys.stderr)
    return 1


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    parser.add_argument("--write-media", required=True)
    args = parser.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.write_media)), exist_ok=True)
    raise SystemExit(
        asyncio.run(
            synthesize(args.text, args.voice, args.rate, args.pitch, args.write_media)
        )
    )


if __name__ == "__main__":
    main()
