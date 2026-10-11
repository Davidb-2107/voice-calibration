ARG BASE_IMAGE=voice-calibration-engine:restore-quarantine
FROM ${BASE_IMAGE}
USER 0
COPY provider_registry.py provider_history.py context.py calibration.py approval_gate.py egress.py server.py install.py /opt/provider-patch/
RUN /opt/venv/bin/python -I /opt/provider-patch/install.py
LABEL voice-calibration.local-patch="provider-registry"
USER 10001:10001
