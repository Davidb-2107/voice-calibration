# Bootstrap diagnostics

The server writes a structured JSON record to stderr for an unexpected bootstrap failure. The private preproduction harness retains stderr in `service.log`. Public HTTP errors remain generic; the response header `x-correlation-id` identifies the corresponding server record. The server generates this ID and ignores client-supplied correlation IDs.

Each record includes `event: bootstrap_failed`, UTC `timestamp`, `correlationId`, the failing `stage`, `durationMs`, `requestDurationMs`, and sanitized error details (`name`, `message`, `code`, `stack`, `stderr`, `cause`). Stages cover authentication, membership, engine startup, credential loading, corpus reading, MCP handshake, run recovery and the individual bootstrap repositories. Nested failures produce one record at the deepest instrumented stage. Normal authentication denials from anonymous health checks do not flood the log.

Authorization tokens, the Supabase publishable key and the effective provider credential are registered within the request context; existing credential redactors also cover an already-running engine. Redaction happens before truncating error fields. Context secrets are released when the request completes and late asynchronous errors cannot log after that release. Logging failure does not replace the original operation error or retry an operation. Request bodies and corpus contents are not deliberately logged.

This instrumentation does not change calibration approvals, durable job transitions, provider execution, retries, or timeouts. Diagnostics stay in operator logs; stack traces and provider stderr are not returned to the client.

Validation on 2026-10-12: six focused diagnostic tests, 266 passing repository tests (one existing conditional test skipped), first cold access with two real Supabase accounts and a simulated provider, followed by onboarding, isolation, interruptions, recovery and restoration with zero replay. The old intermittent bootstrap HTTP 500 remains an incident not reproduced; its cause is not inferred from successful tests. No additional Windows reboot was scheduled.
