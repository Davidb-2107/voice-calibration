# P0.3 service compatibility - local validation

Status: finance remains disabled; no installation, push or activation.
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

Validation so far: fresh npm ci in a disposable export, typecheck/build PASS,
55 targeted tests PASS (financial wire contract, pre-launch control, durable queue),
27 archived release unit tests PASS. Full final suite and paired installation proof pending.
