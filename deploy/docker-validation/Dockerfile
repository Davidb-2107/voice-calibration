# Validation image only: provider calls are replaced by test fixtures.
FROM node:22.14.0-bookworm-slim@sha256:1c18d9ab3af4585870b92e4dbc5cac5a0dc77dd13df1a5905cea89fc720eb05b AS node
FROM python:3.12.10-slim-bookworm@sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PIP_NO_CACHE_DIR=1
COPY Shared /opt/vault/Shared
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install \
       -c /opt/vault/Shared/voice-calibration/requirements.lock \
       /opt/vault/Shared/tiktok-spec /opt/vault/Shared/audio-tools \
       '/opt/vault/Shared/voice-calibration[test]' \
    && /opt/venv/bin/python -m pip check
COPY node /opt/node
WORKDIR /opt/node
RUN npm ci && npm run build
COPY container-validation.py /opt/container-validation.py
RUN useradd --uid 10001 --create-home validator \
    && mkdir -p /opt/vault/temp /opt/fixtures /data \
    && cp /opt/vault/Shared/voice-calibration/test_core_calibration.py /opt/fixtures/ \
    && cp /opt/vault/Shared/voice-calibration/tests/fixtures/hosted_worker.py /opt/fixtures/ \
    && chown -R validator:validator /opt/vault/temp /data
ENV PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin
USER 10001:10001
CMD ["/opt/venv/bin/python", "-I", "/opt/container-validation.py"]
