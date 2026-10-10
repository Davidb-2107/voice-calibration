"""Derive raw-like fixtures from local narrated MP3s; never call a provider."""
import hashlib
import json
import subprocess
from pathlib import Path

from silencedetect_trim import ffprobe_duration_s

root = Path("/data/audio-inputs")
root.mkdir(parents=True, exist_ok=True)
rows = json.loads(Path("/opt/audio-inputs/metadata.json").read_text())
for row in rows:
    source = Path("/opt/audio-inputs") / row["filename"]
    output = root / row["filename"]
    graph = ("[0:a]atrim=end=20,asetpts=PTS-STARTPTS[a];"
             "[0:a]atrim=start=20:end=40,asetpts=PTS-STARTPTS[b];"
             "[0:a]atrim=start=40,asetpts=PTS-STARTPTS[c];"
             "anullsrc=r=44100:cl=mono,atrim=duration=0.8[s1];"
             "anullsrc=r=44100:cl=mono,atrim=duration=0.8[s2];"
             "anullsrc=r=44100:cl=mono,atrim=duration=1.2[s3];"
             "[a][s1][b][s2][c][s3]concat=n=6:v=0:a=1[out]")
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-filter_complex_threads", "1", "-y", "-i", str(source),
                    "-filter_complex", graph, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", str(output)], check=True)
    row.update(preparedPath=str(output), sourceDurationSeconds=ffprobe_duration_s(source),
               preparedDurationSeconds=ffprobe_duration_s(output),
               sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
               preparedSha256=hashlib.sha256(output.read_bytes()).hexdigest())
    assert 60 < row["sourceDurationSeconds"] < 80
    assert row["preparedDurationSeconds"] > row["sourceDurationSeconds"] + 2
(root / "metadata.json").write_text(json.dumps(rows))
print(json.dumps({"fixtures": [{"name": row["name"], "rawSeconds": row["preparedDurationSeconds"]} for row in rows]}))
