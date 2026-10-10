"""Offline fixture: local MP3 responses, installed production audio adapters."""
import json
import os
import resource
import time
from pathlib import Path

from voice_calibration.adapters import load_local_audio_deps
from voice_calibration.core.calibration import run_calibration
from voice_calibration.core.contracts import CalibrationRequest
from voice_calibration.mcp_server import server


def audio_runner(payload, *, context):
    assert context.secrets.get("ELEVENLABS_API_KEY").startswith("benchmark-fake-")
    request = CalibrationRequest.model_validate(payload)
    if request.dry_run:
        return run_calibration(request, persist_results=False, context=context).model_dump(mode="json")
    fixtures = json.loads(Path("/data/audio-inputs/metadata.json").read_text())
    fixture = next(item for item in fixtures if item["text"] == request.text_source.text)
    deps = load_local_audio_deps()
    state = Path(os.environ["VOICE_CALIBRATION_STATE_DIR"])
    state.mkdir(parents=True, exist_ok=True)

    def synthesize(*args):
        with (state / "fake-provider-receipts.jsonl").open("a") as output:
            output.write(json.dumps({"pid": os.getpid(), "simulated": True, "fixture": fixture["name"]}) + "\n")
            output.flush()
            os.fsync(output.fileno())
        # Controlled queue-crash fixture: hold after receipt, before returning any audio.
        if state.parent.name in {"90", "92", "93", "94"}:
            while Path("/data/crash-hold").exists():
                time.sleep(0.05)
        return Path(fixture["preparedPath"]).read_bytes(), {}

    deps.synthesize = synthesize
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.monotonic()
    result = run_calibration(request, deps=deps, persist_results=False, context=context)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    assert result.status == "ok", result.error
    assert len(result.pending_runs) == request.runs
    for observation in result.pending_runs:
        assert observation["duration_raw_s"] > observation["duration_trimmed_s"] > observation["duration_s"] > 0
    with (state / "audio-metrics.jsonl").open("a") as output:
        output.write(json.dumps({"fixture": fixture["name"], "wallSeconds": time.monotonic() - started,
                                 "childCpuSeconds": after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
                                 "childLifetimeMaxRssKiB": after.ru_maxrss,
                                 "durations": [{key: row[key] for key in ("duration_raw_s", "duration_trimmed_s", "duration_s")}
                                               for row in result.pending_runs]}) + "\n")
    return result.model_dump(mode="json")


if __name__ == "__main__":
    server._run_payload = audio_runner
    server.main()
