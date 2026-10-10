"""Offline onboarding validation against the actual private published CUT corpora."""
import json
import sys
from pathlib import Path
from voice_calibration.onboarding import select_voice, validate_ready
from voice_calibration.voice_profile import calibration_context, VoiceProfileError

phase = sys.argv[1]
rows = []
for index in [0, 1, 2, 3, 4, 5, 6, 7, 8, 90, 91, 92, 93, 94]:
    base = Path('/data/benchmark') / str(index)
    context = calibration_context(base / 'corpus/voice_wpm.json')
    voice = 'BENCHMARKCRASH0000001' if index in {90, 92, 93, 94} else 'BENCHMARKVOICE0000001'
    profile = f'elevenlabs:{voice}:fr:benchmark-v1'
    config = select_voice(profile, context=context)
    project = base / 'project'
    project.mkdir(exist_ok=True)
    (project / 'voice.json').write_text(json.dumps(config))
    try:
        validate_ready(json.loads((project / 'voice.json').read_text()), context=context)
        status = 'PASS'
    except VoiceProfileError as error:
        assert 'CUT' in str(error), str(error)
        status = 'BLOCK'
    expected = 'PASS' if phase != 'before' and index in {*range(8), 91} else 'BLOCK'
    assert status == expected, (index, status, expected)
    rows.append({'workspace': index, 'profile': profile, 'status': status})
Path(f'/data/onboarding-{phase}.json').write_text(json.dumps(rows))
print(json.dumps({'status': 'PASS', 'checks': rows}))
