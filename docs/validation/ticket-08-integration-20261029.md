# Ticket 08: local integration preparation, 2026-10-29

Scope: draft service PR #6, coordinated with vault PR #87. No push, merge,
deployment, provider request or change to installed projects is authorized by
this report. Integrate the service first, then the vault.

Baseline: `a72cc46e0604cf31dfb53ba09d5ef8820bdbf916`; PR base
`65ce531bca1c092156538de69a75bbb0cb07d288`. The checkout initially used local
`main`; `session/tiktok-project-voice-spec-20261023` was created at the same
commit before editing. The pre-existing untracked `__pycache__` was preserved.

## Cause and change

The latest GitHub job (123351152174) rejected formatting in
`src/calibration/application.ts`, `bridge.ts`, `docker-transport.ts` and
`http-server.ts`. Only those four files were formatted with the lockfile's
Biome 2.5.14. TypeScript AST comparison against the baseline confirms identical
structure after normalizing parentheses; no business rule, receipt handling,
authorization, spending limit or provider operation changed.

## Isolated validation

Sources were exported with `git archive HEAD` to
`C:\Users\dbele\AppData\Local\Temp\ticket08-clean-un0p9ihb\service`.
No existing `node_modules` was copied. `npm ci` installed the checked-in
lockfile there, with its own npm cache. Runtime: Node 24.18.0 on Windows;
TypeScript 5.9.3, Biome 2.5.14, Playwright 1.62.1, tsx 4.23.15.
Chromium was downloaded only into the disposable directory. Provider-related
environment variables and credentials were removed from the test environment.

| Command in the disposable service | Result |
| --- | --- |
| `npm ci` | PASS |
| `node node_modules/@biomejs/biome/bin/biome ci .` before fix | Four formatting errors reproduced |
| Same Biome check after fix | PASS; six existing warnings and five informational findings remain |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | 328 passed, 0 failed, 10 skipped |
| `npm run test:browser` with isolated Chromium | 1 passed, no provider execution |
| `python -m unittest discover -s docs/validation/provider-registry-session/preproduction -p 'test_release*.py'` | PASS |
| `python -m pytest docs/validation/provider-registry-session/preproduction/test_new_lock_recovery.py -q` | 9 passed |
| TypeScript AST comparison of the four files against baseline | PASS |

Python checks used the new disposable Python 3.12 environment containing only
the declared vault test dependencies. The ten optional integration tests in
the ordinary Node suite require explicit MCP/Docker test settings; their skips
are not a claim that those integrations were exercised by `npm test`.
Coordinated HTTP/MCP verification and the fresh Linux installation evidence are
recorded in the vault's `ticket-08-integration-20261029` report and manifest.

Full local command/output logs are retained under
`C:\Users\dbele\.codex\worktrees\1394\Wiki_Claude\.scratch\ticket08-integration`.
The vault evidence manifest records their hashes and relevant output.

## Limits and delivery boundary

The installed ticket-08 production proof remains historical evidence; it does
not establish GitHub CI success for a new commit. No real calibration,
production or provider replay was repeated. Existing receipt/audio logic is
unchanged by the AST-equivalent formatting. Neither draft PR was pushed or
merged. After an authorized push, GitHub must run the checks on the new head;
do not label it mergeable solely from this local report.
