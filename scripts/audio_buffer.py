"""Bounded PCM buffering shared by the audio callback and pipe reader."""

from threading import Lock


class PcmBuffer:
    """Keep recent complete sample frames and fill missing audio with silence."""

    def __init__(self, maximum_bytes: int, frame_bytes: int = 4) -> None:
        if maximum_bytes < frame_bytes or maximum_bytes % frame_bytes:
            raise ValueError("Buffer capacity must be a positive number of sample frames.")
        self.maximum_bytes = maximum_bytes
        self.frame_bytes = frame_bytes
        self.dropped_bytes = 0
        self._pending = bytearray()
        self._lock = Lock()

    def append(self, audio: bytes) -> None:
        """Drop oldest complete frames when a stalled producer catches up."""
        with self._lock:
            self._pending.extend(audio)
            excess_bytes = len(self._pending) - self.maximum_bytes
            if excess_bytes <= 0:
                return
            discarded_bytes = (
                (excess_bytes + self.frame_bytes - 1) // self.frame_bytes
            ) * self.frame_bytes
            del self._pending[:discarded_bytes]
            self.dropped_bytes += discarded_bytes

    def read(self, requested_bytes: int) -> bytes:
        """Return precisely the callback's requested number of bytes."""
        if requested_bytes < 0 or requested_bytes % self.frame_bytes:
            raise ValueError("Read size must contain complete sample frames.")
        with self._lock:
            available_bytes = min(requested_bytes, len(self._pending))
            available_bytes -= available_bytes % self.frame_bytes
            result = bytes(self._pending[:available_bytes])
            del self._pending[:available_bytes]
        return result + bytes(requested_bytes - available_bytes)
