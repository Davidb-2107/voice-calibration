"""Offline benchmark fixture only; never a production worker."""
import hashlib
import json
import os
import time
from pathlib import Path

from test_core_calibration import FakeDeps
from voice_calibration.core.calibration import run_calibration
from voice_calibration.core.contracts import CalibrationRequest
from voice_calibration.mcp_server import server


class BenchmarkDeps(FakeDeps):
    def synthesize(self, *args):
        # Durable receipt before the fake response, allowing a deterministic mid-call crash.
        path = Path(os.environ["VOICE_CALIBRATION_STATE_DIR"]) / "fake-provider-receipts.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as output:
            output.write(json.dumps({"pid": os.getpid(), "simulated": True}) + "\n")
            output.flush()
            os.fsync(output.fileno())
        buffer = b"b" * (32 * 1024 * 1024)
        hashlib.sha256(buffer).digest()
        time.sleep(0.7)
        return super().synthesize(*args)


def simulated_runner(payload, *, context):
    assert context.secrets.get("ELEVENLABS_API_KEY").startswith("benchmark-fake-")
    request = CalibrationRequest.model_validate(payload)
    deps = BenchmarkDeps(durations=[40.0] * 25)
    return run_calibration(request, deps=deps.as_calibration_deps(),
                           persist_results=False, context=context).model_dump(mode="json")


if __name__ == "__main__":
    server._run_payload = simulated_runner
    server.main()
