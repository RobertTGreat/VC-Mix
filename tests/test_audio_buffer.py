"""Exercise latency limits and sample alignment at the PCM pipe boundary."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from audio_buffer import PcmBuffer


class PcmBufferTests(unittest.TestCase):
    def test_empty_buffer_fills_the_complete_callback_with_silence(self) -> None:
        audio = PcmBuffer(16)
        self.assertEqual(audio.read(8), bytes(8))

    def test_fragmented_pipe_writes_preserve_complete_stereo_samples(self) -> None:
        audio = PcmBuffer(16)
        audio.append(b'abc')
        self.assertEqual(audio.read(4), bytes(4))
        audio.append(b'defgh')
        self.assertEqual(audio.read(8), b'abcdefgh')

    def test_overflow_discards_old_frames_and_keeps_recent_audio(self) -> None:
        audio = PcmBuffer(8)
        audio.append(b'aaaabbbbcccc')
        self.assertEqual(audio.read(8), b'bbbbcccc')
        self.assertEqual(audio.dropped_bytes, 4)

    def test_silence_after_speech_does_not_replay_stale_audio(self) -> None:
        audio = PcmBuffer(16)
        audio.append(b'voice123')
        self.assertEqual(audio.read(8), b'voice123')
        self.assertEqual(audio.read(8), bytes(8))

    def test_two_participants_never_share_pcm_buffers(self) -> None:
        first_user = PcmBuffer(16)
        second_user = PcmBuffer(16)
        first_user.append(b'AAAA')
        second_user.append(b'BBBB')
        self.assertEqual(first_user.read(4), b'AAAA')
        self.assertEqual(second_user.read(4), b'BBBB')

    def test_invalid_capacities_and_partial_frame_reads_fail_explicitly(self) -> None:
        with self.assertRaises(ValueError):
            PcmBuffer(0)
        with self.assertRaises(ValueError):
            PcmBuffer(5)
        with self.assertRaises(ValueError):
            PcmBuffer(8).read(3)


if __name__ == '__main__':
    unittest.main()
