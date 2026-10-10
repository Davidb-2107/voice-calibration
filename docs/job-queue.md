# Durable calibration jobs — private V1

Enable the queue explicitly on `startSupabaseCalibrationApi`:

```js
jobQueue: { dataDir: '/srv/calibration/jobs', maxConcurrentJobs: 4 }
```

Use a private persistent directory disjoint from every workspace's UI, MCP state
and corpus directory. Four is an experimental default, not a validated hosting
capacity. The queue admits only approved, unconsumed, unexpired runs. It schedules
at most four executions globally and one per workspace, in admission order among
eligible workspaces. Startup concurrency remains a separate EngineManager setting.

## HTTP contract

- `POST /api/v1/calibration-runs/:runId/enqueue`: 202 with the durable job.
- `GET /api/v1/calibration-runs/:runId/job`: the authenticated owner's job, or 404.
- `POST /api/v1/calibration-runs/:runId/execute`: uses the same queue when enabled,
  while retaining the synchronous run response for the existing UI.

Mutations still require the bootstrap nonce. Server-resolved user, tenant and
workspace are persisted with the run ID, request digest and configuration identity.
Tokens and provider secrets are never written into jobs. Duplicate submissions
return the existing job and cannot dispatch the same run again.
HTTP duplicate admission reads the durable job directly rather than querying a
busy MCP run reader; only a new admission or authenticated resume reads the run.
Run states, approvals, reports and publication still belong to the existing calibration engine.
`finished` describes the end of an attempt: inspect the run/report for success or
failure; it does not assert a successful calibration or publish a profile.

Before dispatch the API revalidates Supabase identity and current RLS membership,
then checks the persisted request/configuration identity. The engine retains its
own credential binding, expiry, digest, budget and approval-consumption gates.
The waiting request's session remains in memory only. Expiry, revocation or a
changed authorized workspace blocks dispatch and requires fresh authentication.
Revocation does not cancel a provider call already authorized and in progress.

## Restart and failure

The durable states are `queued`, `awaiting_authentication`, `running`, `finished`
and `execution_unknown`. On startup, queued jobs become awaiting authentication;
running jobs become execution unknown. There is **no autonomous paid replay**.
An authenticated enqueue of the same approved run resumes only an awaiting job.
An interrupted attempt requires explicit reconciliation through the existing run
endpoint; a new calibration needs a separately approved proposal, not a replay.

The queue writes a `running` marker before invoking execute. Any exception after
that marker conservatively becomes unknown, even if the provider may not have
been called. A disk failure halts new dispatches/admission and retains ownership
for supervision, including a failed admission write. A graceful close drains active
attempts and persists waiting jobs as awaiting authentication. The protected API
keeps ownership until EngineManager confirms every engine shutdown; failed shutdown
retains the owner lock. Standalone supervisors use `queue.close(() => engines.close())`.
There is no automatic retry loop.

One supervised API process owns `owner.lock`. A second process refuses startup.
After a crash, an operator must confirm that the owner **and its Python children**
have terminated before removing this queue's stale owner/store locks and restarting.
Never remove locks solely because a timeout or PID file looks old. Job data must
remain intact; startup classifies interrupted attempts instead of replaying them.
Lock cleanup is deliberately not automated. Use a broker/transactional coordinator
before deploying multiple API replicas or distributed storage.

The existing fsync + atomic rename and file-lock helpers are reused. Status reads
take the same lock as writes because Windows cannot replace an open file. This
does not prove power-loss durability of a host filesystem or isolation against a
host administrator. Mount the directory with private permissions; process-per-
workspace still does not constitute an OS security boundary.

## Verification

`test/calibration-job-queue.test.mjs`: 100 independent workspaces/limit four,
duplicate admission, foreign reads, one active attempt per workspace, revocation,
configuration changes, explicit resume, actual Node process termination, storage
failure, malformed records, approval gates and compatibility with the existing UI
HTTP response. Providers and Auth are simulated; no ElevenLabs requests are used.
