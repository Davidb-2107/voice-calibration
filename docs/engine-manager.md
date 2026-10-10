# EngineManager V1

The protected Supabase API registers workspaces without starting their engines.
After verifying Auth and fresh membership, a request starts only its authorized
workspace and waits for the identity/schema handshake. It retains the existing HTTP routes,
authentication, tenant/path validation and persistent repositories. The local
standalone CLI is unchanged.

`EngineManager` owns lifecycle only. `CalibrationEngine` is the public application
operation contract, without private repositories or stdio implementation details.
The server-owned `EngineRegistration.create()` currently returns
`createVoiceCalibrationApplication(...)`, which boots and validates the Python
stdio worker. Each invocation must construct a fresh application and transport
bound to the same validated workspace paths. A future remote adapter can implement
the same public methods; its wire protocol, internal authentication and supervision
are not implemented by this change.

## Lifecycle

- `new EngineManager(registrations, { maxConcurrentStarts })` accepts a positive
  safe integer. The conservative library fallback is 1, not a measured deployment
  recommendation. The protected API accepts the same server-owned option; its
  initial startup creates no Python engines.
- `idleTimeoutMs` is server-owned, defaults to 600000 (ten minutes), and must
  be an integer in 1..2147483647. The default is a starting policy, not a measured
  production optimum. A timer starts after creation or the last completed
  operation, and is suspended while any operation or lifecycle transition runs.
  Successful and failed operations both refresh it. Timers are unreferenced.
  Expiry uses the existing confirmed shutdown path. A demand during automatic
  shutdown waits for it, then coalesces a fresh startup. Failed automatic shutdown
  stays blocked until explicit restart/stop recovery; no second engine is created.
- A FIFO permit covers factory creation and the identity/schema handshake only.
  Queued engines do not start their MCP timeout until admitted. Draining and
  shutdown do not hold startup permits. Every creation failure releases its permit.
  Closing the manager skips queued creations and cleans already admitted engines.
- `application(workspaceId)` returns a stable operation facade, not a process handle.
- `start(workspaceId)` explicitly starts the registered engine. Concurrent starts
  share one startup. The protected API resolver calls this after authorization;
  the manager facade itself does not start missing engines or replay operations.
- `restart(workspaceId)` blocks new operations, drains admitted operations, waits
  for shutdown and creates one replacement. Concurrent lifecycle requests share
  the current transition; a restart during initial startup joins that startup.
- `application(workspaceId).close()` drains and stops that workspace only. A later
  explicit `start` can reopen it; another workspace remains available.
- `close()` permanently closes the manager and attempts every workspace shutdown,
  collecting failures. It can be called repeatedly without duplicate shutdowns.
- Failed startup requires explicit retry. Failed shutdown keeps the old handle
  blocked and prevents replacement. A graceful drain has no manager deadline;
  the stdio calls keep their existing timeouts. Remote adapters must provide
  bounded operations and fail closed on an unconfirmed shutdown.

The stdio transport waits for the actual process exit: EOF first, then kill after
two seconds, then a further two seconds for exit confirmation. No confirmed exit
means shutdown fails. A closed transport cannot silently respawn.

## Durable operations

Lifecycle does not propose, approve, execute, reconcile or publish calibration.
Those remain explicit application operations with their existing run identifiers,
configuration fingerprints, gates and repositories. Replacing a process does not
remove approvals, reports, profiles, the WPM corpus or journals. An uncertain
execution remains uncertain until explicit reconciliation; restart never replays it.

Unexpected worker exit retains the existing behavior: transport calls fail and
the application can still read durable local state. Recovery uses explicit
replacement, not automatic synthesis. Containers,
network transport and a public lifecycle endpoint are outside this V1.

## Checks

`test/calibration-engine-manager.test.mjs` checks concurrency, draining, lifecycle
failures, independent workspace availability, an unchanged HTTP handle after
replacement, durable approvals/results/profiles and uncertain executions, and
refusal to duplicate execution. `test/calibration-bridge.test.mjs` includes a real
child that ignores EOF, proving that forced shutdown waits for exit confirmation.

The session report `ENGINE-MANAGER-VALIDATION.md` at the parent workspace root
records actual Python process restart/crash checks and Windows memory/startup
measurements. These are development-host measurements, not production capacity.
`ENGINE-START-LIMIT-VALIDATION.md` records the subsequent Linux experiment with
20 engines and startup limits 2, 3, 4 and 5. The 10-second handshake timeout is
unchanged. `AUDIO-CAPACITY-BENCHMARK.md` records subsequent real audio adapter load.
`ON-DEMAND-ENGINE-VALIDATION.md` records authorized lazy startup and explicit
stop/wake persistence. A registered workspace is not necessarily ready: invalid
credentials, corpus or MCP identity now fail its first authorized wake rather
than the global API boot. All protected routes currently wake their workspace;
engine-free durable reads are not implemented. The optional [durable job queue](job-queue.md)
now limits executions separately from startup permits and revalidates authorization at dispatch.
`IDLE-ENGINE-VALIDATION.md` records automatic idle shutdown, busy protection and
durable stop/wake checks with a short experimental timeout. An injected transport must be recreated by its owning factory
for a stop/wake cycle; production default transports are created per application.
