"""Enumerate Windows outputs or continuously play stereo PCM from standard input."""

import argparse
import json
import sys
import time
from typing import Any

import sounddevice

from audio_buffer import PcmBuffer

SAMPLE_RATE = 48_000
CHANNEL_COUNT = 2
SAMPLE_BYTES = 2
FRAME_BYTES = CHANNEL_COUNT * SAMPLE_BYTES
CALLBACK_FRAMES = 960
MAXIMUM_BUFFER_MILLISECONDS = 200
READ_SIZE_BYTES = 8192


def emit(message: dict[str, Any]) -> None:
    """Reserve stdout for machine-readable control messages."""
    print(json.dumps(message), flush=True)


def list_outputs() -> list[dict[str, Any]]:
    """Return output identities, preferring stable names over transient indices."""
    host_apis = sounddevice.query_hostapis()
    return [
        {
            "id": device_index,
            "name": device["name"],
            "hostApi": host_apis[device["hostapi"]]["name"],
            "channels": device["max_output_channels"],
        }
        for device_index, device in enumerate(sounddevice.query_devices())
        if device["max_output_channels"] >= CHANNEL_COUNT
    ]


def device_settings(device_index: int) -> dict[str, Any]:
    """Let shared-mode WASAPI convert sample rates without exclusive access."""
    device = sounddevice.query_devices(device_index, kind="output")
    host_api = sounddevice.query_hostapis(device["hostapi"])
    extra_settings = None
    if host_api["name"] == "Windows WASAPI":
        extra_settings = sounddevice.WasapiSettings(auto_convert=True)
    return {
        "device": device_index,
        "samplerate": SAMPLE_RATE,
        "channels": CHANNEL_COUNT,
        "dtype": "int16",
        "extra_settings": extra_settings,
    }


def play_output(device_index: int) -> None:
    """Run one independent, continuously clocked output for one participant."""
    capacity_bytes = SAMPLE_RATE * FRAME_BYTES * MAXIMUM_BUFFER_MILLISECONDS // 1000
    audio_buffer = PcmBuffer(capacity_bytes, FRAME_BYTES)
    underflow_count = 0
    last_reported_drops = 0
    last_reported_at = 0.0

    def render_audio(output: Any, frames: int, timing: Any, status: Any) -> None:
        nonlocal underflow_count
        if status.output_underflow:
            underflow_count += 1
        output[:] = audio_buffer.read(frames * FRAME_BYTES)

    with sounddevice.RawOutputStream(
        **device_settings(device_index),
        blocksize=CALLBACK_FRAMES,
        latency="low",
        callback=render_audio,
    ):
        emit({"ready": True, "deviceId": device_index})
        while audio := sys.stdin.buffer.read1(READ_SIZE_BYTES):
            audio_buffer.append(audio)
            now = time.monotonic()
            if audio_buffer.dropped_bytes > last_reported_drops and now - last_reported_at >= 5:
                print(f"Output buffer overrun: discarded {audio_buffer.dropped_bytes} bytes to limit delay.",
                      file=sys.stderr, flush=True)
                last_reported_drops = audio_buffer.dropped_bytes
                last_reported_at = now
    emit({"closed": True, "droppedBytes": audio_buffer.dropped_bytes,
          "underflows": underflow_count})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["list", "check", "play"])
    parser.add_argument("--device", type=int)
    arguments = parser.parse_args()
    try:
        if arguments.command == "list":
            emit({"devices": list_outputs()})
            return 0
        if arguments.device is None:
            parser.error("--device is required for check and play")
        if arguments.command == "check":
            sounddevice.check_output_settings(**device_settings(arguments.device))
            emit({"supported": True})
            return 0
        play_output(arguments.device)
        return 0
    except (sounddevice.PortAudioError, ValueError, OSError) as error:
        print(f"Audio device operation failed: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
