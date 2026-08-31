#!/usr/bin/env python3
"""
Generates the eight notification sounds.

These are placeholders in quality, not in function. §19 asks for sounds that are
"short, professional, distinguishable, low latency", and the one property a
script can guarantee is the third: each is a different interval, envelope and
direction, so a trader can tell an opening from a stop loss without looking.

Committed as generated files rather than left to a build step, because a build
that has to synthesise audio is a build that fails on a machine without Python.
Re-run this to change them; replace them with recorded assets when there is a
designer.
"""
import math
import struct
import wave
from pathlib import Path

RATE = 44_100
OUT = Path(__file__).resolve().parent.parent / "assets" / "sounds"

# name -> (frequencies in order, seconds per note, waveform hint)
SOUNDS = {
    # Rising major third: something began.
    "trade_opened": ([587.33, 739.99], 0.09, "sine"),
    # Falling: something ended.
    "trade_closed": ([739.99, 587.33], 0.09, "sine"),
    # Two quick identical notes: something changed, nothing began or ended.
    "trade_modified": ([659.25, 659.25], 0.055, "sine"),
    # A single confident note.
    "order_filled": ([783.99], 0.11, "sine"),
    # A single low note: withdrawn.
    "order_cancelled": ([392.00], 0.11, "sine"),
    # Falling minor third, lower register: a loss was taken.
    "stop_loss": ([493.88, 415.30], 0.10, "triangle"),
    # Rising perfect fifth: a gain was taken.
    "take_profit": ([587.33, 880.00], 0.10, "triangle"),
    # Three urgent repeats: attention.
    "risk_warning": ([880.00, 880.00, 880.00], 0.07, "square"),
}


def wave_sample(kind: str, phase: float) -> float:
    if kind == "square":
        return 1.0 if math.sin(phase) >= 0 else -1.0
    if kind == "triangle":
        return 2.0 / math.pi * math.asin(math.sin(phase))
    return math.sin(phase)


def render(frequencies, seconds_per_note, kind) -> bytes:
    frames = bytearray()
    for frequency in frequencies:
        count = int(RATE * seconds_per_note)
        for index in range(count):
            t = index / RATE
            # A short attack and a longer decay. Without an envelope the abrupt
            # start and stop produce a click that is louder than the tone.
            attack = min(1.0, index / (RATE * 0.005))
            decay = max(0.0, 1.0 - index / count) ** 1.5
            value = wave_sample(kind, 2 * math.pi * frequency * t) * attack * decay * 0.35
            frames += struct.pack("<h", int(max(-1.0, min(1.0, value)) * 32_767))
        # A breath between notes, so two notes read as two.
        frames += b"\x00\x00" * int(RATE * 0.012)
    return bytes(frames)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (frequencies, seconds, kind) in SOUNDS.items():
        path = OUT / f"{name}.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes(render(frequencies, seconds, kind))
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
