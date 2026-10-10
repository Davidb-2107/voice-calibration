# Hosted Supabase Auth V1 (candidate, not deployed)

Hosted development project `voice-calibration-dev` (`pfuamavgzpxypyeidjsa`) is
configured. Its migration, real Auth sessions, SQL privileges/RLS and two-account
isolation have been tested with the local protected API. Calibration provider
and audio remain simulated; no application is deployed publicly.

## Boundary

Engine lifecycle uses `EngineManager`. The server-owned `maxConcurrentStarts`
option bounds concurrent creation/handshake across workspaces (library fallback
1); initial API startup creates no Python engines. Only the workspace authorized
by fresh Auth/RLS checks is started when its protected request arrives. This limit changes neither
tenant authorization nor calibration approvals. See [lifecycle contract](engine-manager.md).

The server-owned `idleTimeoutMs` defaults to ten minutes after the last completed
operation. Active operations suspend the countdown. Automatic shutdown preserves
durable state; a subsequent authorized request wakes a fresh engine. A failed
shutdown blocks that workspace pending explicit supervision. This initial policy
has not been selected as a final production capacity setting.

`email/password login → user access token → verified Auth user → fresh RLS
workspace → immutable server registry → private application/stdio worker`

Every protected API request calls `GET /auth/v1/user`, then reads
`calibration_workspaces` with the **same user bearer token** and the project's
publishable key. No service-role key, decoded unverified JWT, user metadata or
caller supplied tenant determines authority. Missing, expired, anonymous or
unconfirmed identity fails before business IO. No membership cache.

V1 supports one active tenant per account and one workspace per tenant. Several
accounts can share an explicitly provisioned tenant. No automatic enrollment or
client membership writes. Changing a DB owner without updating the server registry
denies access; changing a runtime tenant invalidates prior consent.

Private data, MCP state, WPM files and credentials belong to the server registry.
Each corpus directory is private, including its journal/lock/temporary sidecars;
two workspaces cannot put even distinct corpus files in the same directory.
Cross-workspace overlapping paths and sidecar symlink escapes are rejected. Credentials
freeze when its engine is created; rotation needs engine replacement and fresh approval. Node consent uses
V3 HMAC including the tenant; historical local V1/V2 identities stay compatible.
Python verifies its startup tenant/workspace and includes the tenant in core
consent. The stdio worker must remain private to its gateway; its `gateway`
principal is trusted process identity, not the human user.

This is an API entrypoint. The existing unauthenticated local UI remains a
separate local entrypoint and must **not** be used to deploy the protected API.
No new login screen or custom refresh/session implementation is added. Use the
official Supabase client for email/password login and session refresh.

## Configure the hosted project (operator)

1. Create a hosted test project. Keep email/password enabled, disable anonymous
   login and other login providers; require confirmed email. Configure its email
   delivery and Auth abuse protection before exposing a login UI.
2. Apply `supabase/migrations/202610090001_calibration_tenants.sql` with the SQL
   editor or normal Supabase migration tooling. Only identity/membership goes to
   Postgres; no corpus migration.
3. Create and confirm two test accounts. Provision tenant/workspace rows and
   memberships using the SQL editor/operator access. Never permit self grants.

```sql
-- Replace UUIDs with actual confirmed Auth user IDs; no credentials in these rows.
insert into public.calibration_tenants (id) values ('tenant-a'), ('tenant-b');
insert into public.calibration_workspaces (id, tenant_id)
values ('workspace-a', 'tenant-a'), ('workspace-b', 'tenant-b');
insert into public.calibration_memberships (user_id, tenant_id)
values ('<user-a-uuid>', 'tenant-a'), ('<user-b-uuid>', 'tenant-b');
```

4. Store URL and the new `sb_publishable_...` key in deployment configuration.
   The protected adapter deliberately refuses secret/service-role and legacy keys.
   Keep each ElevenLabs credential in server secret storage, never in the browser,
   these tables, logs or source control.
5. Start the API behind HTTPS with an explicit trusted `publicOrigin`. It ignores
   forwarded identity headers. Bind the worker/server to a private interface.

```js
import { startSupabaseCalibrationApi } from 'voice-calibration';
const api = await startSupabaseCalibrationApi({
  supabase: { url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY },
  host: '127.0.0.1', port: 8787, publicOrigin: 'https://calibration.example.com',
  jobQueue: { dataDir: '/srv/calibration/jobs', maxConcurrentJobs: 4 },
  workspaces: [
    { tenantId: 'tenant-a', workspaceId: 'workspace-a',
      dataDir: '/srv/calibration/a/ui', stateDir: '/srv/calibration/a/state',
      wpmPath: '/srv/calibration/a/voice_wpm.json', credentials: { envFile: '/run/secrets/a.env' } },
    { tenantId: 'tenant-b', workspaceId: 'workspace-b',
      dataDir: '/srv/calibration/b/ui', stateDir: '/srv/calibration/b/state',
      wpmPath: '/srv/calibration/b/voice_wpm.json', credentials: { envFile: '/run/secrets/b.env' } },
  ],
});
```

Install the accompanying Python tenant adapter before using this entrypoint.
The optional [durable job queue](job-queue.md) limits executions and revalidates
authorization before dispatch. Its private directory must not overlap a workspace.
After restart waiting jobs require fresh authentication; interrupted executions
require reconciliation. Four concurrent jobs is an experimental starting value.
An old worker omitting `tenant_id` is refused during its first authorized wake,
before that workspace's business operation. API availability alone does not
attest readiness of all dormant workspaces. Python and
its launch command must use the deployment's declared environment. In local
development use the repository's prescribed runtime, not global PATH fallback.

## Login and real two-account verification (pending)

In a client using the official `@supabase/supabase-js` library:

```js
const { data, error } = await supabase.auth.signInWithPassword({ email, password });
if (error) throw error;
const bootstrap = await fetch(`${apiOrigin}/api/v1/bootstrap`, {
  headers: { Authorization: `Bearer ${data.session.access_token}` },
});
```

Do not print/store credentials or sessions in test artifacts. The API uses bearer
tokens, not cookie sessions. Clients must send the current token on **every**
request, plus their bootstrap nonce on mutations. Cross-origin requests are
refused; host the future client on the same public origin. Existing core approval,
cost preview, unknown-execution reconciliation and publication controls stay in
force. No new per-tenant billing or quota service is implemented.

For an actual hosted proof, log in as each account and check its own bootstrap,
corpus and profiles, then attempt the other account's workspace hint, run IDs,
nonce and profile publication. All foreign operations must fail before provider
access. Remove one membership and reuse its still valid token: access must fail
on the next request. This does not cancel an already authorized in-flight call.

Run `supabase/tests/calibration_tenants.sql` as postgres in a disposable test
project after the migration. It verifies real SQL privileges/RLS for two users,
refuses self grants/reassignment, checks membership revocation and rolls back all
fixtures. Do not run fixture UUIDs on a populated production database.

Finally test two **real** confirmed Auth sessions against the deployed API with
a simulated calibration provider. This is separate from SQL role simulation and
does not authorize paid ElevenLabs synthesis. Real projects/onboarding must also
be validated through the workspace's normal project workflow before deployment.

## Verified offline

Build and full Node regressions; two mocked Auth accounts with isolated local
corpus/runs/profiles, separate nonces and mandatory approval; metadata forgery,
foreign workspace/run, membership removal, malformed/unavailable Auth, ambiguous
membership, unsafe auth URL/key, overlapping aliases, wrong Python tenant and
credential binding. See `.scratch/supabase-auth-v1/validation.md` for counts.

## Verified with hosted Auth/RLS — 2026-10-09

Migration recorded remotely as `20261009142509_calibration_tenants`; SQL role
tests pass and roll back fixtures. Two reserved confirmed test accounts each see
only their own identity rows and cannot grant themselves membership.

Opt-in `test/hosted-supabase-validation.mjs` runs real sessions through the local
protected API and two Python stdio workers. `tests/fixtures/hosted_worker.py` in
the companion vault candidate substitutes provider/audio only. Fresh private
corpora start at CUT BLOCK; five automatically published synthetic observations
per corpus produce PASS. Cross-account workspace/run/nonce and execution before
consent are blocked. Revocation blocks an existing token; restoration is checked.
The same accounts pass repeated runs in new private corpora.

Parent orchestration is retained in the session workspace under
`temp/supabase_hosted_validation.py`; sessions remain in memory/private stdin.
Three offline regressions cover stalled stdout, a lost DELETE response and failed
child shutdown. These artifacts prove hosted identity and local engine isolation,
not real audio accuracy, clean installation or public deployment.

References: [getUser](https://supabase.com/docs/reference/javascript/auth-getuser),
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security),
[API keys](https://supabase.com/docs/guides/getting-started/api-keys).
