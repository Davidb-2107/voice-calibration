# Workspace Isolation Implementation Plan

**Statut :** implémenté, revu et fusionné dans `main` le 2026-10-01 via la [PR #4](https://github.com/Davidb-2107/voice-calibration/pull/4), commit de fusion `2910c6e`.

Les cases cochées indiquent les étapes réalisées. Le détail ci-dessous conserve la séquence d'implémentation ; le bilan final figure dans la section « Réalisation et intégration ».

**Goal:** Isoler les données et commandes locales par workspace tout en conservant le parcours et les fichiers de `local-default`.

**Architecture:** Une instance HTTP fixe son workspace au démarrage. L'application et les dépôts prennent ce contexte explicitement pour chaque accès à un run ou à un artefact ; le pont vérifie le workspace des réponses MCP avant toute projection. Les intégrations et les garanties locales existantes restent en place.

**Tech Stack:** TypeScript strict, Node.js 18+, ESM, `node:http`, fichiers JSON locaux, tests `node:test`. Aucun ajout de dépendance.

**Spec:** `docs/superpowers/specs/2026-09-30-workspace-isolation-design.md` — lire sa version actuelle, qui inclut le contrat canonique des IDs, l'ordre de reprise et le contrôle des réponses MCP.

## Global Constraints

- Une instance du serveur est liée à un seul `workspaceId`, fixé au démarrage. La valeur par défaut reste `local-default`.
- Les IDs de workspace respectent `^[a-z0-9][a-z0-9_-]*$`. Rejeter les variantes de casse sans conversion silencieuse, avant toute I/O liée à l'appel.
- Une configuration invalide empêche le démarrage ; un ID HTTP invalide reçoit `400 invalid_workspace_id`, un ID valide contradictoire reçoit `400 workspace_mismatch`.
- Un run absent ou étranger reçoit `404` avant reprise, pont MCP, lecture de rapport ou publication.
- Conserver la disposition et les références existantes sous `workspaces/local-default/`, sans migration.
- Aucun hébergement, authentification, base de données, stockage objet, worker, sélecteur UI ou nouveau drapeau CLI dans cette étape.
- Les credentials et le WPM canonique restent globaux ; cette étape ne permet pas une exposition SaaS multi-utilisateur.
- Utiliser Git Bash pour les commandes. Exécuter les vérifications avec de faux credentials et transports ; aucun appel ElevenLabs réel.
- **Consigne initiale : aucun commit ni push** pendant la préparation et l'exécution isolée. Les étapes de commit de la skill ont été remplacées par une inspection du diff. L'intégration locale, les commits, le push et la fusion ont ensuite été autorisés explicitement par l'utilisateur.
- L'exécution a été autorisée après validation du design et invocation de `superpowers:subagent-driven-development`. Les trois tâches ont été réalisées séquentiellement dans un worktree isolé, avec revues indépendantes.

## Review Focus

1. IDs qui se confondent sous Windows : rejeter `WORKSPACE-A`, chaîne vide, valeur non string et séparateurs avant I/O — tâche 1, puis frontière HTTP de tâche 2.
2. Identités cachées ou répétées : contrôler toutes les occurrences de query `workspaceId`, le corps direct et les objets `input`/`draft`, même si une première valeur correspond — tâche 2.
3. Première demande étrangère après redémarrage : retourner `404` sans transformer un run local `running` en `execution_unknown` — tâche 2.
4. Même ID de run dans deux workspaces et anciennes références de rapport : choisir le bon fichier et refuser l'artefact voisin, sans migration de `local-default` — tâche 2.
5. Publication MCP confirmée pour un workspace étranger : rejeter avant extraction de `PublicationResult`, vérification canonique et écriture de profil ; couvrir aussi les cinq autres opérations — tâche 3.

## Carte des fichiers

| Fichier | Responsabilité du changement |
|---|---|
| `src/calibration/domain.ts` | Validation canonique partagée, erreur identifiable à la frontière HTTP |
| `src/calibration/ports.ts` | Signatures explicites des dépôts de runs et d'artefacts |
| `src/calibration/local-store.ts` | Chemins, confinement et validation des appels directs |
| `src/calibration/application.ts` | Propagation du workspace, appartenance avant reprise, rapports et verrous |
| `src/calibration/http-server.ts` | Workspace fixé, validation query/corps, adaptation de toutes les routes |
| `src/calibration/entrypoint.ts` | Option programmatique `workspaceId`, validation avant découverte des credentials |
| `src/ui/calibration-client.ts` | Retrait du workspace fixé dans le corps du dry-run |
| `src/calibration/bridge.ts` | Validation des six réponses MCP qui contiennent un record |
| `test/calibration-domain.test.mjs` | Identités valides et invalides |
| `test/calibration-storage.test.mjs` | Partition réelle, verrouillage, références et compatibilité |
| `test/calibration-api.test.mjs` | Doubles partitionnés, refus croisés et ordre de reprise |
| `test/calibration-bridge.test.mjs` | Réponses MCP étrangères |
| `test/calibration-e2e.test.mjs` | Parcours complet dans `local-default` et un second workspace |
| `test/calibration-ui-client.test.mjs` | Corps navigateur sans `workspaceId` imposé |
| `docs/calibration-architecture.md` et `README.md` | Contrats locaux finaux et limites SaaS |

Base observée lors de la préparation : `d339a84`. Avant exécution, inspecter les changements intervenus depuis cette base et les conserver. Réutiliser les tests et helpers existants ; ne pas découper les modules de production pour cette seule évolution.

---

### Task 1: Valider l'identité canonique avant les effets

**Files:**
- Modify: `src/calibration/domain.ts`, `src/calibration/local-store.ts`, `src/calibration/application.ts`, `src/calibration/http-server.ts`, `src/calibration/entrypoint.ts`.
- Test: `test/calibration-domain.test.mjs`, `test/calibration-storage.test.mjs`, `test/calibration-api.test.mjs`.

**Interfaces:**
- Produces: `assertWorkspaceId(value: unknown): asserts value is string` et `InvalidWorkspaceIdError` exportés depuis `domain.ts`.
- Produces: option programmatique `CalibrationUiOptions.workspaceId?: string` ; sa transmission au serveur ne modifie pas la CLI.
- Consumes: contrats actuels des dépôts, encore inchangés à cette tâche.

- [x] **Step 1: Ajouter le test du contrat au fichier de domaine.** Importer les deux nouveaux exports et les assertions nécessaires :

```js
test("workspace IDs have one canonical spelling", () => {
  for (const id of ["local-default", "workspace-a", "a_2", "0"]) {
    doesNotThrow(() => assertWorkspaceId(id));
  }
  for (const id of ["", "WORKSPACE-A", "a/b", "a\\b", ".", "..", "a b", "é", null, 3]) {
    throws(() => assertWorkspaceId(id), InvalidWorkspaceIdError);
  }
});
```

- [x] **Step 2: Vérifier l'échec avant implémentation.** Depuis la racine du dépôt, Git Bash : `npm run build && node --test test/calibration-domain.test.mjs`. Attendre un échec lié aux nouveaux exports absents.

- [x] **Step 3: Ajouter la validation commune dans `domain.ts`.**

```ts
export class InvalidWorkspaceIdError extends Error {
  readonly code = "invalid_workspace_id";
  constructor() {
    super("invalid workspaceId");
    this.name = "InvalidWorkspaceIdError";
  }
}

export function assertWorkspaceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    throw new InvalidWorkspaceIdError();
  }
}
```

- [x] **Step 4: Ajouter les tests de refus avant I/O.** Dans les tests de stockage, utiliser un sous-répertoire absent d'un répertoire temporaire nettoyé avec `t.after` :

```js
test("noncanonical workspace is rejected before storage IO", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "workspace-validation-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "not-created");
  const store = createLocalStore(root);
  await rejects(store.corpus.getDraft("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(store.runs.create({ ...runFixture, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  await rejects(store.runs.save({ ...runFixture, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
  await rejects(store.profiles.publish({ workspaceId: "WORKSPACE-A", id: "p" }), /invalid workspaceId/);
  strictEqual(existsSync(root), false);
});
```

Ajouter `existsSync` à l'import `node:fs`. Dans les tests API, un `Proxy` permet de prouver qu'aucun dépôt n'est invoqué et une application minimale vérifie le refus de démarrage :

```js
test("invalid workspace is rejected before application IO or server start", async () => {
  const touch = () => { throw new Error("unexpected IO"); };
  const repositories = {
    corpus: new Proxy({}, { get: () => touch }),
    runs: new Proxy({}, { get: () => touch }),
    profiles: new Proxy({}, { get: () => touch }),
    artifacts: new Proxy({}, { get: () => touch }),
  };
  const app = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  await rejects(app.getBootstrap("WORKSPACE-A"), /invalid workspaceId/);
  await rejects(startCalibrationUi({ application: app, workspaceId: "WORKSPACE-A" }), /invalid workspaceId/);
});
```

La construction de l'application lit les propriétés `runs.list` et `runs.recoverRunning` mais n'appelle pas leurs fonctions ; le Proxy ci-dessus autorise cette vérification de forme. Ajouter aussi un test `startVoiceCalibrationUi({ workspaceId: "WORKSPACE-A" })` qui refuse avant création des credentials ; importer le lanceur depuis `dist/calibration/entrypoint.js`.

- [x] **Step 5: Brancher la validation aux frontières.** Commencer `workspaceRoot` par `assertWorkspaceId(workspaceId)`. Valider `run.workspaceId` au début de `runs.create/save`, et `profile.workspaceId` avant toute écriture de profil. Au début de `corpus.saveDraft`, valider aussi `draft.workspaceId` et son égalité avec le workspace attendu, avant la queue et le verrou :

```ts
assertWorkspaceId(workspaceId);
assertWorkspaceId(draft.workspaceId);
if (draft.workspaceId !== workspaceId) throw new Error("draft workspace mismatch");
```

Dans l'application, valider avant `ensureRecovered`/dépôts les entrées `getBootstrap`, `getCorpus`, `getDraft`, `saveDraft`, `publishCorpusVersion`, `prepareDryRun`, `listVoiceProfiles` ; valider aussi `draft.workspaceId` dans `saveDraft` avant son contrôle d'égalité. Exemple :

```ts
async prepareDryRun(input: CalibrationInput): Promise<CalibrationRun> {
  assertWorkspaceId(input.workspaceId);
  // Le corps existant suit cette validation.
}
```

Dans `entrypoint.ts`, ajouter `workspaceId?: string`, résoudre/valider cette valeur au tout début de `startVoiceCalibrationUi`, avant `createCredentialProvider()`, puis la transmettre à `startCalibrationUi`. Valider la configuration aussi dans `createCalibrationServer` et au début de `startCalibrationUi`. Dans `dispatch`, déplacer la résolution/validation du workspace à l'intérieur du `try` ; mapper `InvalidWorkspaceIdError` vers 400 et son code dans `statusForError`/`errorPayload`.

- [x] **Step 6: Vérifier la tâche et inspecter le diff.** `npm run build && npm run typecheck && node --test test/calibration-domain.test.mjs test/calibration-storage.test.mjs test/calibration-api.test.mjs`. Attendre le succès. Examiner `git diff --check` et `git diff --stat` ; aucun commit.

### Task 2: Propager le workspace dans tout le parcours local

**Files:**
- Modify: `src/calibration/ports.ts`, `src/calibration/local-store.ts`, `src/calibration/application.ts`, `src/calibration/http-server.ts`, `src/ui/calibration-client.ts`.
- Test: `test/calibration-storage.test.mjs`, `test/calibration-api.test.mjs`, `test/calibration-e2e.test.mjs`, `test/calibration-ui-client.test.mjs`.
- Docs: `docs/calibration-architecture.md`, `README.md`.

**Interfaces:**
- Consumes: `assertWorkspaceId` et `InvalidWorkspaceIdError` de tâche 1.
- Produces: signatures ci-dessous ; l'identité est toujours le premier argument pour les méthodes par ID.

```ts
// CalibrationRunRepository
get(workspaceId: string, id: string): Promise<CalibrationRun | null>;
recoverRunning(workspaceId: string, runId: string, recoveredAt: string): Promise<CalibrationRun | null>;
consumeApproval?(workspaceId: string, runId: string, consumedAt: string): Promise<CalibrationRun>;
// create(run), save(run) et list(workspaceId) gardent leurs signatures.

// ArtifactStore
put(workspaceId: string, runId: string, name: string, bytes: Uint8Array): Promise<string>;
get(workspaceId: string, ref: string): Promise<Uint8Array>;

// CalibrationApplication
getRun(workspaceId: string, runId: string): Promise<CalibrationRun | null>;
getReport(workspaceId: string, runId: string): Promise<CalibrationReport | null>;
approve(workspaceId: string, runId: string, input: { requestDigest: string }): Promise<CalibrationRun>;
execute(workspaceId: string, runId: string): Promise<CalibrationRun>;
reconcile(workspaceId: string, runId: string): Promise<CalibrationRun>;
publishProfile(workspaceId: string, runId: string): Promise<VoiceProfile>;
```

- [x] **Step 1: Ajouter une preuve de partition dans les tests de stockage réels.** Conserver `runFixture`, compléter son approbation et ajouter les imports nécessaires. Ce test vérifie aussi la collision d'ID et la consommation atomique :

```js
test("workspaces partition every local resource", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createLocalStore(root);
  const refs = {};
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    const draft = await store.corpus.getDraft(workspaceId);
    const saved = await store.corpus.saveDraft(workspaceId, {
      ...draft, items: [{ id: "t1", order: 0, text: workspaceId }],
    }, draft.revision);
    const version = await store.corpus.publishDraft(workspaceId, saved.revision);
    const run = { ...runFixture, workspaceId, status: "approved", approval: {
      approvedAt: "2026-09-02T10:00:00Z", expiresAt: "2026-09-02T10:15:00Z", consumedAt: null,
    } };
    await store.runs.create(run);
    refs[workspaceId] = await store.artifacts.put(workspaceId, run.id, "report.json", Buffer.from(workspaceId));
    await store.profiles.publish({
      id: "profile-1", workspaceId, voiceRef: "voice-1", wpmSnapshot: 148,
      wpmAuthority: "python-voice-wpm", canonicalRef: "python://wpm", sourceRunId: run.id,
      corpusVersionId: version.id, reportId: refs[workspaceId], publishedAt: run.createdAt,
    });
  }
  const reloaded = createLocalStore(root);
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    strictEqual((await reloaded.runs.get(workspaceId, "run-1")).workspaceId, workspaceId);
    strictEqual((await reloaded.runs.list(workspaceId)).length, 1);
    strictEqual((await reloaded.corpus.getActiveVersion(workspaceId)).items[0].text, workspaceId);
    strictEqual((await reloaded.profiles.list(workspaceId))[0].workspaceId, workspaceId);
    strictEqual(Buffer.from(await reloaded.artifacts.get(workspaceId, refs[workspaceId])).toString(), workspaceId);
  }
  await rejects(reloaded.artifacts.get("workspace-a", refs["workspace-b"]), /invalid artifact reference/);
  await reloaded.runs.consumeApproval("workspace-a", "run-1", "2026-09-02T10:01:00Z");
  await reloaded.runs.recoverRunning("workspace-a", "run-1", "2026-09-02T10:02:00Z");
  strictEqual((await reloaded.runs.get("workspace-a", "run-1")).status, "execution_unknown");
  strictEqual((await reloaded.runs.get("workspace-b", "run-1")).status, "approved");
});
```

- [x] **Step 2: Exécuter le nouveau test avant modification.** `npm run build && node --test --test-name-pattern="workspaces partition" test/calibration-storage.test.mjs`. Attendre un échec de partition/signature avec le stockage actuel.

- [x] **Step 3: Changer les contrats et chemins de stockage.** Appliquer les signatures ci-dessus dans `ports.ts`. Utiliser cette fonction dans le dépôt de runs pour toutes les opérations, sans toucher aux verrous existants :

```ts
const pathFor = (workspaceId: string, id: string) =>
  join(workspaceRoot(dataDir, workspaceId), "runs", `${safeSegment(id, "runId")}.json`);
// create/save : pathFor(run.workspaceId, run.id)
// get/recoverRunning/consumeApproval : pathFor(workspaceId, runId)
```

Pour les artefacts, calculer les racines par appel :

```ts
const workspacePath = workspaceRoot(dataDir, workspaceId);
const artifactsRoot = resolve(workspacePath, "artifacts");
// put :
const target = safeArtifactPath(workspacePath, runId, name);
await assertNoSymlinkWithin(artifactsRoot, target);
await writeAtomic(target, bytes);
return relative(dataDir, target).split("\\").join("/");
// get :
const target = resolve(dataDir, ref);
if (target !== artifactsRoot && !target.startsWith(`${artifactsRoot}${sep}`)) {
  throw new Error("invalid artifact reference");
}
await assertNoSymlinkWithin(artifactsRoot, target);
return new Uint8Array(await readFile(target));
```

Mettre à jour les appels existants de `calibration-storage.test.mjs` avec `"local-default"` en premier argument. Conserver ses assertions exactes de layout, traversée et symlink. Ajouter les appels directs avec workspace invalide à `runs.get/list/recoverRunning/consumeApproval` et `artifacts.put/get` ; tous doivent refuser avant création de répertoire.

- [x] **Step 4: Propager le contexte dans l'application avant reprise.** Modifier les six signatures publiques et `getRunOrThrow`. Valider le workspace au début de chaque méthode ; le verrou par run utilise `JSON.stringify([workspaceId, runId])` au lieu de `runId` seul. Employer la séquence suivante dans `getRun` avant le bloc existant de projection MCP :

```ts
assertWorkspaceId(workspaceId);
const initial = await this.repositories.runs.get(workspaceId, runId);
if (!initial || initial.workspaceId !== workspaceId) return null;
await this.ensureRecovered(workspaceId);
const local = await this.repositories.runs.get(workspaceId, runId);
if (!local || local.workspaceId !== workspaceId) return null;
// Le bloc existant commence ensuite avec :
if (!isCoreBackedRun(local) || !this.bridge.getRun) return local;
```

Transmettre le contexte dans `getReport`, `getRunOrThrow`, les trois `withRunLock`, les appels à `recoverRunning`/`consumeApproval`, `persistReport` et `loadReport`. Exemples exacts :

```ts
return this.repositories.artifacts.put(run.workspaceId, run.id, REPORT_NAME, bytes);
const bytes = await this.repositories.artifacts.get(run.workspaceId, run.reportId);
await this.repositories.runs.recoverRunning(workspaceId, run.id, recoveredAt);
await this.repositories.runs.consumeApproval(workspaceId, run.id, consumedAt);
```

- [x] **Step 5: Adapter les doubles et tous les callers existants.** Dans `memoryRepositories`, les maps de runs sont indexées par `JSON.stringify([workspaceId, id])`, les profils sont filtrés par workspace et les artefacts incluent ce workspace dans la référence et la clé. Exemple :

```js
const runKey = (workspaceId, id) => JSON.stringify([workspaceId, id]);
// runs.create/save
runs.set(runKey(run.workspaceId, run.id), structuredClone(run));
// runs.get
const run = runs.get(runKey(workspaceId, id));
return run ? structuredClone(run) : null;
// runs.list
return [...runs.values()].filter((run) => run.workspaceId === workspaceId).map((run) => structuredClone(run));
// artifacts.put/get
const ref = `artifact://${workspaceId}/${runId}/${name}`;
// get doit refuser avant lecture si !ref.startsWith(`artifact://${workspaceId}/`).
```

Partitionner aussi l'état corpus ; remplacer les variables uniques `draft`, `activeVersion`, `versions` par une map et récupérer cet état dans chacune des cinq méthodes :

```js
const corpusByWorkspace = new Map();
function corpusState(workspaceId) {
  let state = corpusByWorkspace.get(workspaceId);
  if (!state) {
    state = { draft: { workspaceId, revision: 0, items: [] }, activeVersion: null, versions: [] };
    corpusByWorkspace.set(workspaceId, state);
  }
  return state;
}
```

`recoverRunning` lit et réécrit avec `runKey(workspaceId, runId)`. Conserver le comportement facultatif de `consumeApproval` des doubles existants. Ajouter `workspaceId = "local-default"` comme paramètre à `publishCorpus` et remplacer ses trois usages de la constante par ce paramètre. Adapter les appels `app.*` et `repositories.runs.get` des tests API à la nouvelle signature. Utiliser `rg -n 'runs\.(get|recoverRunning|consumeApproval)|artifacts\.(put|get)|\.(getRun|getReport|approve|execute|reconcile|publishProfile)\(' src test` pour couvrir tous les callers, puis `npm run typecheck`.

Dans le helper `coreGateBridge`, rendre explicite son workspace fixé : `function coreGateBridge(workspaceId = "local-default")`. `makeRecord` utilise cette variable au lieu d'une constante. Chacune des méthodes `propose`, `approve`, `getRun`, `execute` et `reconcile` vérifie son entrée avant de retourner/modifier le record :

```js
strictEqual(inputValue.workspaceId, workspaceId);
```

Ajouter `inputValue` aux signatures des méthodes qui n'avaient pas de paramètre et inclure `workspaceId` dans le retour de `propose`. Conserver les compteurs existants et le chemin legacy de `fakeBridge` : ce dernier ne stocke aucun record par workspace et transporte une requête déjà résolue.

- [x] **Step 6: Fixer le workspace HTTP et contrôler toutes les identités fournies.** Capturer une copie des options avec le workspace validé dans `createCalibrationServer` avant de créer le callback, afin qu'une mutation ultérieure des options ne change pas l'identité de l'instance. Remplacer la sélection par query par ce contrôle :

```ts
function assertRequestWorkspace(url: URL, body: Record<string, unknown> | undefined, workspaceId: string): void {
  const supplied: unknown[] = url.searchParams.getAll("workspaceId");
  for (const candidate of [body, body?.input, body?.draft]) {
    if (isRecord(candidate) && Object.hasOwn(candidate, "workspaceId")) supplied.push(candidate.workspaceId);
  }
  for (const value of supplied) {
    assertWorkspaceId(value);
    if (value !== workspaceId) throw new HttpError(400, "workspace_mismatch", "workspace does not match server instance");
  }
}
```

Appeler ce contrôle des query à l'intérieur du `try`, avant l'appel applicatif. Dans chaque route POST/PUT reconnue, conserver `requireNonce`, parser le corps une fois, puis vérifier ses identités avant l'application. La route `reconcile` doit aussi parser/vérifier le corps, même si elle n'utilise aucune autre donnée. Ajouter le workspace aux six opérations par ID et à `getReport` dans la réponse GET et dans le traitement d'erreur d'exécution. Pour le dry-run :

```ts
const input = isRecord(body.input) ? body.input : body;
const run = await application.prepareDryRun({ ...input, workspaceId } as never);
```

Retirer `workspaceId: "local-default"` du corps envoyé par le navigateur. Compléter le test client existant pour vérifier l'absence de cette propriété dans la requête capturée.

- [x] **Step 7: Prouver le refus avant reprise sur un stockage réel.** Ajouter `readFileSync`, `readdirSync` aux imports API et cette capture sans écriture :

```js
function snapshotFiles(root) {
  const snapshot = {};
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else snapshot[path] = readFileSync(path, "base64");
    }
  }
  visit(root);
  return snapshot;
}

test("foreign first request does not recover local runs", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositories = createLocalStore(root);
  const seed = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  for (const workspaceId of ["workspace-a", "workspace-b"]) await publishCorpus(repositories, workspaceId);
  const runA = await seed.prepareDryRun({ ...input, workspaceId: "workspace-a" });
  const approved = await seed.approve("workspace-a", runA.id, { requestDigest: runA.requestDigest });
  await repositories.runs.save({ ...approved, status: "running", approval: {
    ...approved.approval, consumedAt: "2026-09-02T10:00:00Z",
  } });
  const runB = await seed.prepareDryRun({ ...input, workspaceId: "workspace-b" });
  const bridge = fakeBridge();
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories: createLocalStore(root), bridge, canonical });
  const ui = await startCalibrationUi({ application: app, workspaceId: "workspace-a" });
  t.after(() => ui.close());
  const before = snapshotFiles(root);
  // Ne pas appeler bootstrap avant cette première demande étrangère.
  const headers = { "content-type": "application/json", "x-calibration-nonce": app.getSessionNonce() };
  const requests = [
    ["GET", `/calibration-runs/${runB.id}`, undefined],
    ["POST", `/calibration-runs/${runB.id}/approve`, { requestDigest: runB.requestDigest }],
    ["POST", `/calibration-runs/${runB.id}/execute`, {}],
    ["POST", `/calibration-runs/${runB.id}/reconcile`, {}],
    ["POST", "/voice-profiles", { runId: runB.id }],
  ];
  for (const [method, path, value] of requests) {
    const response = await fetch(`${ui.url}/api/v1${path}`, {
      method, headers, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    strictEqual(response.status, 404);
    deepStrictEqual(snapshotFiles(root), before);
  }
  strictEqual(bridge.state.dryRuns.length, 0);
  strictEqual(bridge.state.executions.length, 0);
  strictEqual(canonical.calls.length, 0);
  const allowed = await fetch(`${ui.url}/api/v1/calibration-runs/${runA.id}`);
  strictEqual(allowed.status, 200);
  strictEqual((await allowed.json()).status, "execution_unknown");
});
```

Dans ce même test, avant la lecture autorisée, ajouter les appels directs suivants :

```js
strictEqual(await app.getRun("workspace-a", runB.id), null);
strictEqual(await app.getReport("workspace-a", runB.id), null);
for (const operation of [
  () => app.approve("workspace-a", runB.id, { requestDigest: runB.requestDigest }),
  () => app.execute("workspace-a", runB.id),
  () => app.reconcile("workspace-a", runB.id),
  () => app.publishProfile("workspace-a", runB.id),
]) {
  await rejects(operation(), { name: "NotFoundError" });
  deepStrictEqual(snapshotFiles(root), before);
}
for (const operation of [
  () => app.getRun("WORKSPACE-A", runB.id),
  () => app.getReport("WORKSPACE-A", runB.id),
  () => app.approve("WORKSPACE-A", runB.id, { requestDigest: runB.requestDigest }),
  () => app.execute("WORKSPACE-A", runB.id),
  () => app.reconcile("WORKSPACE-A", runB.id),
  () => app.publishProfile("WORKSPACE-A", runB.id),
]) {
  await rejects(operation(), /invalid workspaceId/);
  deepStrictEqual(snapshotFiles(root), before);
}
const badRepositories = memoryRepositories();
badRepositories.runs.get = async () => structuredClone(runB);
badRepositories.runs.list = async () => { throw new Error("unexpected recovery"); };
const badApp = makeApplication({ repositories: badRepositories, bridge, canonical });
strictEqual(await badApp.getRun("workspace-a", runB.id), null);
strictEqual(await badApp.getReport("workspace-a", runB.id), null);
```

- [x] **Step 8: Tester les identités HTTP cachées et invalides.** Ajouter ce test complet ; chaque demande reçoit le code attendu et laisse le snapshot inchangé :

```js
test("HTTP checks every supplied workspace identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-http-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = fakeBridge();
  const app = makeApplication({ repositories: createLocalStore(root), bridge, canonical: fakeCanonicalProfilePort() });
  const ui = await startCalibrationUi({ application: app, workspaceId: "workspace-a" });
  t.after(() => ui.close());
  const headers = { "content-type": "application/json", "x-calibration-nonce": app.getSessionNonce() };
  const before = snapshotFiles(root);
const cases = [
  ["GET", "/bootstrap?workspaceId=WORKSPACE-A", undefined, "invalid_workspace_id"],
  ["GET", "/bootstrap?workspaceId=workspace-b", undefined, "workspace_mismatch"],
  ["GET", "/bootstrap?workspaceId=workspace-a&workspaceId=workspace-b", undefined, "workspace_mismatch"],
  ["POST", "/calibration-runs/dry-run", { workspaceId: "workspace-b" }, "workspace_mismatch"],
  ["POST", "/calibration-runs/dry-run", { input: { workspaceId: "workspace-b" } }, "workspace_mismatch"],
  ["PUT", "/corpus/draft", { draft: { workspaceId: "workspace-b" } }, "workspace_mismatch"],
  ["POST", "/voice-profiles", { workspaceId: null }, "invalid_workspace_id"],
];
for (const [method, path, value, code] of cases) {
  const response = await fetch(`${ui.url}/api/v1${path}`, {
    method, headers: { ...headers, "if-match": 'W/"corpus-draft-0"' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  strictEqual(response.status, 400);
  strictEqual((await response.json()).error.code, code);
  deepStrictEqual(snapshotFiles(root), before);
}
  for (const action of ["approve", "execute", "reconcile"]) {
    const response = await fetch(`${ui.url}/api/v1/calibration-runs/foreign/${action}`, {
      method: "POST", headers, body: JSON.stringify({ workspaceId: "workspace-b" }),
    });
    strictEqual(response.status, 400);
    strictEqual((await response.json()).error.code, "workspace_mismatch");
    deepStrictEqual(snapshotFiles(root), before);
  }
  const shadowed = await fetch(`${ui.url}/api/v1/calibration-runs/dry-run?workspaceId=workspace-a`, {
    method: "POST", headers,
    body: JSON.stringify({ workspaceId: "workspace-a", input: { workspaceId: "workspace-b" } }),
  });
  strictEqual(shadowed.status, 400);
  strictEqual((await shadowed.json()).error.code, "workspace_mismatch");
  deepStrictEqual(snapshotFiles(root), before);
  strictEqual((await fetch(`${ui.url}/api/v1/bootstrap?workspaceId=workspace-a`)).status, 200);
  strictEqual(bridge.state.dryRuns.length, 0);
  strictEqual(bridge.state.executions.length, 0);
});
```

Pour un corps direct ou imbriqué égal au serveur, le parcours positif de l'étape suivante démontre l'acceptation. Ajouter aussi au test de refus avant I/O de tâche 1 `store.corpus.saveDraft("workspace-a", { workspaceId: "WORKSPACE-A", revision: 0, items: [] }, 0)` ; le répertoire absent reste absent.

- [x] **Step 9: Vérifier le parcours complet dans deux workspaces et les anciens rapports.** Remplacer la déclaration du test E2E principal par ces deux lignes et ajouter la fermeture du `for` après sa fermeture actuelle :

```js
for (const workspaceId of ["local-default", "workspace-a"]) {
test(`local calibration MVP completes in ${workspaceId}`, async (t) => {
```

Passer cette valeur à `startCalibrationUi`, aux corps contenant explicitement un workspace, et aux assertions de layout. Conserver l'intégralité des assertions existantes sur corpus, approbation, coûts, publication et retries interdits. Pour `workspace-a`, tester un dry-run sans workspace dans le corps et un draft imbriqué contenant la même identité. Le stockage reste `createLocalStore`, jamais le double mémoire. Les transformations ciblées sont :

```js
const ui = await startCalibrationUi({ application, workspaceId, host: "127.0.0.1", port: 0 });
// Dans l'objet de la première demande dry-run :
...(workspaceId === "local-default" ? { workspaceId } : {}),
// Corps du premier PUT draft :
JSON.stringify(workspaceId === "local-default" ? { ...draft, items: texts } : { draft: { ...draft, items: texts } })
```

Ajouter au test de layout existant un rapport précréé avec `writeFileSync` sous `workspaces/local-default/artifacts/run-1/report.json`, conserver sa référence relative dans le run, puis vérifier :

```js
const ref = "workspaces/local-default/artifacts/run-1/report.json";
await store.runs.save({ ...runFixture, reportId: ref });
strictEqual((await reloaded.runs.get("local-default", runFixture.id)).reportId, ref);
deepStrictEqual(JSON.parse(Buffer.from(await reloaded.artifacts.get("local-default", ref)).toString()), { legacy: true });
await rejects(reloaded.artifacts.get("workspace-a", ref), /invalid artifact reference/);
```

- [x] **Step 10: Mettre les contrats locaux dans la documentation et vérifier l'ensemble.** Ajouter à `calibration-architecture.md` le paragraphe ci-dessous et la nouvelle signature des ports ; adapter le tableau de layout pour montrer `workspaces/<workspace-id>/` et préciser que `local-default` conserve ses fichiers. Dans README, documenter l'option programmatique uniquement :

```md
Une instance locale appartient au workspace fixé à son démarrage (`local-default` par défaut).
Les appels HTTP ne peuvent pas sélectionner un autre workspace. Les IDs utilisent uniquement
les minuscules ASCII, chiffres, tirets et underscores. Les runs et artefacts sont vérifiés dans
ce contexte avant toute reprise ou opération. Les credentials ElevenLabs et le WPM canonique
restent globaux ; cette isolation locale ne suffit pas pour un SaaS multi-utilisateur.
```

Exécuter `npm run build && npm run typecheck && npm test && npm run lint`, puis `git diff --check`. Résoudre les usages restants de signatures anciennes dans les helpers et tests existants. Inspecter le diff ; aucun commit.

### Task 3: Refuser les records MCP appartenant à un autre workspace

**Files:** Modify `src/calibration/bridge.ts` ; Test `test/calibration-bridge.test.mjs`, `test/calibration-api.test.mjs` ; Docs `docs/calibration-architecture.md`.

**Interfaces:**
- Consumes: signatures applicatives de tâche 2 et `assertWorkspaceId` de tâche 1.
- Produces: helper privé `parseScopedCoreRun(value: unknown, workspaceId: string): CoreRunRecord`. Les signatures publiques de `CalibrationBridge` restent identiques.

- [x] **Step 1: Ajouter une matrice de six réponses étrangères.** Réutiliser `resolvedRequest` et les imports du fichier bridge ; le transport ci-dessous ne lance aucun processus :

```js
test("bridge rejects foreign workspace records in every core operation", async () => {
  const record = {
    run_id: "core-run-1", workspace_id: "workspace-b", revision: 3, status: "succeeded",
    context: {}, request: {}, request_digest: "v1:sha256:test", proposal: {}, approval: null,
    result: { status: "ok", precision_stats: { median: 148 }, publication: {
      status: "published", canonical_ref: "python://wpm", wpm: 148,
    } },
    created_at: "2026-09-02T10:00:00Z", updated_at: "2026-09-02T10:01:00Z",
  };
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool() { return { response: record, emitted: true, stderr: "" }; },
    async close() {},
  };
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({
    env: { ELEVENLABS_API_KEY: "test-secret" },
  }) });
  const context = { workspaceId: "workspace-a", runId: "core-run-1" };
  for (const operation of [
    () => bridge.propose({ workspaceId: context.workspaceId, request: resolvedRequest }),
    () => bridge.approve({ ...context, requestDigest: record.request_digest }),
    () => bridge.getRun(context),
    () => bridge.execute({ ...context, coreRunId: context.runId, idempotencyKey: context.runId, snapshot: resolvedRequest }),
    () => bridge.reconcile({ ...context, coreRunId: context.runId, idempotencyKey: context.runId }),
    () => bridge.publish(context),
  ]) await rejects(operation(), /calibration core workspace mismatch/);
});
```

- [x] **Step 2: Constater l'échec.** `npm run build && node --test --test-name-pattern="foreign workspace records" test/calibration-bridge.test.mjs`. Attendre un échec « missing expected rejection » avec l'implémentation actuelle.

- [x] **Step 3: Centraliser le contrôle avant extraction.** Importer `assertWorkspaceId` depuis `domain.ts`, puis ajouter :

```ts
function parseScopedCoreRun(value: unknown, workspaceId: string): CoreRunRecord {
  assertWorkspaceId(workspaceId);
  const run = parseCoreRun(value);
  if (run.workspaceId !== workspaceId) throw new Error("calibration core workspace mismatch");
  return run;
}
```

Dans les six opérations `propose/approve/getRun/execute/reconcile/publish`, valider le workspace d'entrée avant `invokeTool`, puis remplacer leur appel à `parseCoreRun(redact(...))` par `parseScopedCoreRun(redact(...), input.workspaceId)`. Dans `execute` et `reconcile`, ce contrôle s'applique à la branche core-backed où `workspaceId` et `coreRunId` sont présents ; garder le chemin legacy existant. Dans `publish`, effectuer le contrôle avant `resultObject(run.result).publication`, car `PublicationResult` ne transporte plus le workspace.

- [x] **Step 4: Vérifier que la publication étrangère ne produit aucun profil local.** Dans les tests API, ajouter les imports `createCalibrationBridge` et `createCredentialProvider`. Utiliser un vrai `createLocalStore` temporaire et un faux transport ; préparer un run réussi legacy avec les helpers existants, puis faire retourner par `publish_calibration` un record étranger confirmé :

```js
test("foreign MCP publication never verifies or saves a local profile", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "workspace-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repositories = createLocalStore(root);
  await publishCorpus(repositories, "workspace-a");
  const seed = makeApplication({ repositories, bridge: fakeBridge(), canonical: fakeCanonicalProfilePort() });
  const run = await seed.prepareDryRun({ ...input, workspaceId: "workspace-a" });
  await seed.approve("workspace-a", run.id, { requestDigest: run.requestDigest });
  await seed.execute("workspace-a", run.id);
  const calls = [];
  const transport = {
    async schema() { return { type: "object" }; },
    async callTool(name) {
      calls.push(name);
      return { emitted: true, stderr: "", response: {
        run_id: run.id, workspace_id: "workspace-b", revision: 3, status: "succeeded",
        context: {}, request: {}, request_digest: "v1:sha256:test", proposal: {}, approval: null,
        result: { publication: { status: "published", canonical_ref: "python://wpm", wpm: 148 } },
        created_at: run.createdAt, updated_at: run.updatedAt,
      } };
    },
    async close() {},
  };
  const bridge = createCalibrationBridge({ transport, credentials: createCredentialProvider({
    env: { ELEVENLABS_API_KEY: "test-secret" },
  }) });
  const canonical = fakeCanonicalProfilePort();
  const app = makeApplication({ repositories, bridge, canonical });
  const before = snapshotFiles(root);
  await rejects(app.publishProfile("workspace-a", run.id), /calibration core workspace mismatch/);
  deepStrictEqual(calls, ["publish_calibration"]);
  strictEqual(canonical.calls.length, 0);
  strictEqual((await repositories.profiles.list("workspace-a")).length, 0);
  deepStrictEqual(snapshotFiles(root), before);
});
```

Le run préparé par `fakeBridge` garde un digest legacy : sa lecture ne déclenche pas `get_calibration_run`, ce qui concentre ce test sur la publication réelle du pont. Les tests core-backed existants continuent à valider les réponses correctes.

- [x] **Step 5: Documenter la limite et terminer la vérification.** Ajouter à `calibration-architecture.md` :

```md
Le pont refuse tout record MCP dont le workspace ne correspond pas à l'appel, y compris
avant extraction d'une publication confirmée. Ce contrôle empêche la projection locale,
la vérification canonique et l'écriture du profil après une réponse contradictoire ;
il ne peut pas annuler une action déjà exécutée par le cœur MCP externe.
```

Exécuter une fois après les derniers changements `npm run build && npm run typecheck && npm test && npm run lint`, puis `git diff --check` et `git status --short`. Inspecter le diff des fichiers listés et conserver les changements d'autres intervenants. Aucun commit, push ou appel provider réel. Toute panne d'environnement doit être rapportée avec la commande et son résultat ; ne pas remplacer une vérification échouée par une affirmation de succès.

## Réalisation et intégration

Les trois tâches et leurs 21 étapes sont terminées : validation canonique avant I/O, propagation du workspace dans le parcours local et rejet des records MCP étrangers. Chaque tâche a été revue indépendamment. La revue finale a identifié deux contournements supplémentaires, corrigés et relus : le workspace `null` au démarrage et les valeurs invalides fournies au pont avant sélection du chemin core ou legacy.

La correction préexistante de découverte commune du vault a été conservée et isolée dans un commit distinct. L'intégration comprend :

- `e29f255` : découverte commune du vault pour les credentials et le launcher, avec test hors du vault.
- `a6c6e43` : isolation des workspaces, spécification et plan.
- `aa62592` : trois ajustements de formatage dans deux fichiers, après le premier check CI.

La [PR #4](https://github.com/Davidb-2107/voice-calibration/pull/4) a été fusionnée dans `main` le 2026-10-01, au commit `2910c6e`. La [CI après fusion](https://github.com/Davidb-2107/voice-calibration/actions/runs/36825972573) a réussi, y compris le contrôle Biome complet, typecheck, build, `npm test` et le scan de secrets.

### Validation et limite de l'environnement local

Le résultat intégré a passé build, typecheck, lint et les 103 cas des neuf fichiers de tests du projet via `npm test -- "test/*.test.mjs"`. Dans le checkout Windows utilisé pour l'intégration, `npm test` sans ciblage découvrait aussi deux scripts tiers Windows dans un ancien environnement Python sous `temp/`, avec les erreurs `ScriptEngine is not defined` et `WScript is not defined`. Cette anomalie locale a été rapportée ; aucune configuration n'a été modifiée pour la masquer. La CI sur checkout propre a passé la commande `npm test` normale.

### Périmètre terminé

Cette livraison couvre l'isolation locale, avec un workspace fixé par instance et la compatibilité de `local-default`. Les credentials ElevenLabs et le WPM canonique restent globaux. L'authentification, les autorisations, les credentials par utilisateur, la base de données, le stockage objet, les workers et l'API publique du moteur restent hors périmètre et nécessitent des travaux SaaS distincts.
