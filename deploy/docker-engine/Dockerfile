FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY Shared /opt/Shared
RUN python -m venv /opt/venv && /opt/venv/bin/pip install \
    -c /opt/Shared/voice-calibration/requirements.lock \
    /opt/Shared/tiktok-spec /opt/Shared/audio-tools /opt/Shared/voice-calibration \
    && /opt/venv/bin/pip check \
    && useradd --uid 10001 --create-home engine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1
USER 10001:10001
WORKDIR /workspace
CMD ["/opt/venv/bin/python", "-I", "-m", "voice_calibration.mcp_server.server"]
