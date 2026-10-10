"""Register private test profiles; never import developer corpora."""
import json
import sys
from pathlib import Path
from voice_calibration.onboarding import create_profile
from voice_calibration.voice_profile import calibration_context

root = Path(sys.argv[1])
count = int(sys.argv[2])
aliases = [("BenchmarkVoice", "BENCHMARKVOICE0000001"), ("CrashVoice", "BENCHMARKCRASH0000001")]
if len(sys.argv) > 3:
    aliases = [(f"AudioVoice_{trial}_{concurrency}", f"BENCHMARK{trial:04d}{concurrency:07d}")
               for trial in range(1, int(sys.argv[3]) + 1) for concurrency in [1, 5, 10, 20]]
for index in range(count):
    corpus = root / str(index) / "corpus" / "voice_wpm.json"
    corpus.parent.mkdir(parents=True)
    corpus.write_text("{}")
    for alias, voice in aliases:
        create_profile({"voice_id": voice, "model_id": "eleven_multilingual_v2",
                        "voice_settings": {"stability": 0.65, "similarity_boost": 0.75,
                                           "style": 0.0, "use_speaker_boost": True, "speed": 1.0},
                        "corpus": {"alias": alias, "language": "fr"}, "atempo": 1.0},
                       f"elevenlabs:{voice}:fr:benchmark-v1", context=calibration_context(corpus))
print(json.dumps({"registered": count}))
