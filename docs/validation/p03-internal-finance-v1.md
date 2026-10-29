# P0.3 service compatibility - local validation

Status: local acceptance verified 2026-10-29. Finance remains disabled;
no installed-service update, push or activation.
Paired engine contract and full rollback recipe live in the vault at
`docs/validation/p03-internal-finance-v1.md`. Approved plan: vault
`docs/superpowers/plans/p03-internal-finance/P03-IMPLEMENTATION-PLAN.md`.

The two project consent proposal routes accept optional ASCII
`financialOperationKey` (1..128 characters, alphanumeric start, then `._:-`
or alphanumeric). It is proposal-only. Responses add both
`financialSchema=internal-finance-v1` and UUID4 `financialOperationId`.
No authority, ledger, financial scope or client balances are exposed.
Legacy closed response schemas stay exact when finance is absent.
The signed generic MCP prepare-project bridge already transports these fields.
Durable queue identity continues to bind the engine's run ID; the signed registry
enforces closure and single dispatch even if JSON queue data is deleted or restored.

The external trusted release reader must run before any candidate process.
It authenticates each independent provider registry and validates a separately signed
qualification bound to API runtime hash and immutable engine image. It rejects
unknown, incompatible or self-asserted capability. Never load this reader from the
candidate's environment. The release authority key lives outside candidate data.
EngineManager's optional operator-owned preflight callback runs before create and
on restart. A future installed update must wire it and the external controller for
every guarded workspace; that update remains a separately authorized operation.

The archived harness was exercised only on temporary fixture roots. It is not an
autonomous installer. No installed API, engine, project or permission was modified.
Without a qualified older financial target, rollback means stopped/quarantined with
provider network blocked and independent registry preserved, never an older database.

Code target: `68d5ee78c0c1c439b176366f8e22b6ebba98c10c`, paired with vault
`5508da10a42091e5616a2ac72821e0a504b56c64`. Evidence-only commits follow these
runtime targets. Base: `f27fda8b1ab8d521b7e67621046a0c28d802e5b0`.

Final checks: Biome CI, typecheck, build and lint exit 0. Complete Node suite:
342 PASS, 1 historical native-Docker skip, no failure, with two concurrent files.
Both actual HTTP/MCP financial cases pass with admission enabled and disabled.
Served invitation browser: 1 PASS. Standalone release controller: 28 PASS,
also in a new stdlib-only venv without a vault package. Recovery controller:
9 PASS under Python 3.12. Real paired wheel/controller: 5 PASS, zero provider
calls or target starts. Vault engine: 970 PASS/7 skips, financial 79 PASS/0 skips,
launcher 276 PASS/2 skips. Installed wheel acceptance covers the 5 Category B
source skips with 5 PASS/0 skips in a fresh Linux container.

[p03-local-evidence.json](p03-local-evidence.json) records results, immutable code
targets, container IDs, limitations and eleven log/JUnit SHA256 values. The retained
evidence root is `C:/Users/dbele/AppData/Local/Temp/p03-validation-pekti61d`.
Exact commands are in `evidence-attempt4/service-commands.json` and
`evidence-extra/service-bounded.log`. All containers run with network mode `none`.
The complete vault document contains installation recipes, the 18-scenario matrix,
11-invariant mapping, independent review and rollback limits.

Versions: Node 22.23.4, npm 10.9.9, engine Python 3.11.18, controller Python
3.12.16, pytest 9.1.1. Fresh `npm ci --ignore-scripts --no-audit --no-fund` uses
only the disposable export. Chromium and OS libraries are installed only in its
disposable image. The archived recovery controller needs Python 3.12 because it
uses `Path.is_junction`; this is separate from engine Python 3.11 support.

Commands: `npm exec -- biome ci .`, `npm run typecheck`, `npm run build`,
`npm run lint`, `npm test -- --test-concurrency=2`, `npm run test:browser`;
`python -I -m unittest discover -s docs/validation/provider-registry-session/preproduction -p 'test_release*.py'`;
`python3.12 -m pytest docs/validation/provider-registry-session/preproduction/test_new_lock_recovery.py -q`;
`python -I docs/validation/p03-paired-preflight.py` with the corrected wheel installed.

The first default-concurrency full run had one historical MCP initialization
timeout. It passes alone and in the bounded complete run, with its original
deadline and assertions. Linux Biome initially received Windows CRLF exports;
only disposable `i/lf` text was converted to Git Linux checkout bytes. No global
repository or evidence reformat occurred. Standalone synthetic children now install
their explicit TCP denial before the bench probe, retaining fail-closed behavior.

Controller units verify ordering through the reader port. The paired command uses
the real installed reader for legacy-before-marker, exact qualified target and
missing, forged or rewritten qualifications. This does not attest an actual
installed target. Independent Standards/Spec reinspection has zero open P1/P2.

Integrate service before vault. The local service origin currently points to
`C:/Users/dbele/src/voice-calibration`, not GitHub. A separately authorized push
must explicitly target `https://github.com/Davidb-2107/voice-calibration.git`.
No remote config was changed. Both original worktrees retain their prior changes
and no staged changes; all temporary environments, branches and worktrees are retained.
