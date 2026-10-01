# Instance Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurer explicitement les credentials ElevenLabs et la source WPM par instance, les transmettre au MCP et empêcher la reprise d'un run avec une autre configuration.

**Architecture:** Le lanceur résout et fige la configuration, puis partage le provider existant et le même chemin WPM avec le port canonique et le transport MCP. Une empreinte backend est conservée sur chaque nouveau run ; les opérations vérifient cette identité avant leurs effets. La consultation des archives reste locale lorsque leur configuration n'est pas compatible.

**Tech Stack:** TypeScript strict, Node.js 18+, ESM, `node:crypto`, `node:path`, `node:url`, `node:test`, stockage JSON existant ; Python et mécanismes de verrouillage du package partagé. Aucune nouvelle dépendance.

**Spec:** [2026-10-01-instance-configuration-design.md](../specs/2026-10-01-instance-configuration-design.md), validée par l'utilisateur le 2026-10-01. Lire cette spécification avant toute tâche.

## Global Constraints

- « Une instance HTTP reste liée à un seul workspace. »
- « Les deux sources sont obligatoires pour tout workspace autre que `local-default`. »
- « Un opérateur peut choisir volontairement les mêmes credentials et le même fichier pour deux instances, mais doit les fournir à chacune. »
- « Les priorités de découverte historiques restent identiques ; leur résultat est désormais fixe pour la durée de l'instance. »
- « Pas de clé dans une option CLI, une URL, un formulaire, un snapshot de run ou un fichier de configuration versionné. »
- « Ne persister que cette empreinte ; la clé demeure dans le provider. »
- « Les runs historiques sans identité de configuration restent consultables, mais leur reprise est bloquée. »
- « Ne pas ajouter de writer WPM Node. »
- « Aucun changement Python n'est effectué par cette spécification. » Le lot Python ne commence qu'après autorisation d'exécution et ouverture d'un worktree vault par `vault-session`.
- Pas de produit/code modifié pendant la préparation du plan. Pas de commit, push, intégration ou déploiement dans cette phase documentaire. Les commandes de contrôle utilisent Git Bash et `rtk` ; les lectures du vault utilisent Obsidian.
- Aucun appel ElevenLabs réel pour les tests. Ne pas exposer le contenu d'un `.env` ou l'environnement complet dans les preuves.

## Review Focus

1. Fichier `.env` explicite sans clé alors que le processus en possède une : refuser sans repli et sans fuite — tâche 2.
2. Run core-backed historique ou appartenant à une ancienne configuration : GET/rapport/bootstrap restent consultables sans rafraîchissement MCP ni écriture du run — tâche 4.
3. Projection d'une réponse du gate après approbation/exécution : préserver l'empreinte locale au lieu de la perdre — tâche 4.
4. Chemin WPM relatif avec espaces et environnement changé avant le premier spawn : Node et child conservent la même source absolue — tâches 2 et 3.
5. Deux WPM distincts dans un même répertoire : leurs journaux/verrous ne se mélangent pas ; un résultat de B ne valide pas A — tâches 3 et 5.

## Carte des fichiers et dépendances

| Fichier | Responsabilité |
|---|---|
| `src/calibration/fingerprint.ts` | Ajouter le calcul de configuration sans toucher au digest fournisseur |
| `src/calibration/domain.ts` | Métadonnée optionnelle de run pour lire les archives |
| `src/calibration/entrypoint.ts` | Options publiques, validation, snapshot credentials/WPM, composition |
| `src/calibration/credentials.ts` | Provider et parseur existants, réutilisés sans changer leurs priorités historiques |
| `src/calibration/bridge.ts` | Environnement figé du child, override WPM, lecture canonique et références |
| `src/calibration/application.ts` | Identité obligatoire à la création, garde, lecture/recovery compatibles, conservation des projections |
| `src/calibration/ports.ts` | Code de conflit identifiable sans nouveau mécanisme d'erreur |
| `src/calibration/http-server.ts` | Réutiliser le mapping 409, exposer les codes de conflit |
| `src/calibration-cli.ts` | Trois flags transmis à l'interface publique |
| `test/calibration-{domain,entrypoint,bridge,api,storage,e2e,autonomy}.test.mjs` | Étendre les checks existants ; fixtures temporaires, sans nouveau framework |
| `Shared/voice-calibration/voice_wpm.py` dans le vault | Support effectif de l'override, journal et verrous associés, si absent |
| `Shared/voice-calibration/tests/test_instance_wpm_paths.py` | Test Python de résolution ; tests de writes dans les tests existants révélés au préflight |
| `README.md`, `docs/calibration-architecture.md`, `docs/elevenlabs-calibration-contract-inventory.md` | Contrat livré et preuves Node/Python actuelles |

Ordre : préflight → tâche 1 → tâche 2 → tâche 3 → tâche 4 → tâche 5 → tâche 6. Pas d'édition concurrente de `entrypoint.ts` ou `bridge.ts`. Le lot Python a son propre worktree, diff et validation ; il reste une dépendance de la livraison finale.

## Préflight : établir la compatibilité réelle du Python

**État de préparation :** le Node a été inspecté sur `4ed449d`. L'inventaire Python date du 2026-09-02. Deux tentatives de lecture du `voice_wpm.py` actuel via Obsidian ont échoué parce que l'application n'était pas disponible. Ne pas transformer cet inventaire en preuve d'override supporté.

**Files :** lecture seule de `Shared/voice-calibration/{README.md,pyproject.toml,voice_wpm.py,core/calibration.py,mcp_server/server.py}` ; actualisation de l'inventaire dans ce dépôt après vérification.

- [ ] **Step 1 : lire les sources actuelles via Obsidian et le runtime effectivement choisi.**

Depuis Git Bash, exécuter séparément :

```bash
rtk proxy obsidian vault=Wiki_Claude read path="Shared/voice-calibration/README.md"
rtk proxy obsidian vault=Wiki_Claude read path="Shared/voice-calibration/pyproject.toml"
rtk proxy obsidian vault=Wiki_Claude read path="Shared/voice-calibration/voice_wpm.py"
rtk proxy obsidian vault=Wiki_Claude read path="Shared/voice-calibration/core/calibration.py"
rtk proxy obsidian vault=Wiki_Claude read path="Shared/voice-calibration/mcp_server/server.py"
rtk proxy type -a voice-calibration-mcp
```

Analyser les sorties hors contexte brut. Relever : résolution de `WPM_PATH`/`RUNS_LOG_PATH`, toutes leurs utilisations, noms des verrous, signatures des lectures/`log_run`, fixtures de synthèse simulée, stockage du gate et éventuel chargement `.env` dans le child. Vérifier le package associé au lanceur, pas seulement le Python générique du PATH.

- [ ] **Step 2 : prouver le comportement import-time dans le même runtime, avec deux JSON temporaires.** Utiliser le test Python de la tâche 5 ; aucun appel au provider. Comparer les chemins effectifs du module aux overrides. Si le support existe, la tâche 5 devient vérification/régression plutôt qu'une réécriture.
- [ ] **Step 3 : enregistrer l'évidence et les chemins de tests actuels dans l'inventaire.** Indiquer date, version, module importé, méthode de vérification et résultat. Ne pas recopier des secrets ou une liste de runtimes dynamique.
- [ ] **Gate :** si Obsidian/runtime ne permet pas cette vérification, les tâches Node peuvent être réalisées avec faux MCP après approbation, mais le lot Python et la livraison restent non vérifiés. Si les sources ont une organisation incompatible avec les fichiers/interfaces ci-dessous, corriger ce plan avant toute édition Python. Ne pas installer un MCP alternatif ni contourner le protocole vault.

### Task 1 : identité backend et métadonnée persistante

**Files :** modify `src/calibration/fingerprint.ts`, `src/calibration/domain.ts`, `src/calibration/application.ts:54` ; test `test/calibration-domain.test.mjs` et `test/calibration-storage.test.mjs`.

**Interfaces :**

- Produces: `fingerprintConfiguration(input: { workspaceId: string; provider: "elevenlabs"; wpmPath?: string }, secret: string): string`.
- Produces: `CalibrationRun.configurationIdentity?: string` et `CalibrationApplicationOptions.configurationIdentity?: string`.
- L'option absente autorise la consultation ; la tâche 4 interdira la création/reprise sans identité. `requestDigest` et `ResolvedCalibrationRequest` sont inchangés.

- [ ] **Step 1 : ajouter le test de stabilité/changement.** Importer le nouveau helper dans le fichier de test domaine existant.

```js
test("configuration fingerprint changes with key and WPM source", () => {
  const config = { workspaceId: "workspace-a", provider: "elevenlabs", wpmPath: "C:/calibration/a.json" };
  const first = fingerprintConfiguration(config, "key-a");
  match(first, /^v1:hmac-sha256:[a-f0-9]{64}$/);
  strictEqual(first, fingerprintConfiguration({ ...config }, "key-a"));
  strictEqual(first === fingerprintConfiguration(config, "key-b"), false);
  strictEqual(first === fingerprintConfiguration({ ...config, wpmPath: "C:/calibration/b.json" }, "key-a"), false);
  strictEqual(first.includes("key-a"), false);
});
```

- [ ] **Step 2 : constater le rouge.** `rtk npm run build`, puis `rtk proxy node --test test/calibration-domain.test.mjs`. Attendu : import/fonction absente, pas une erreur d'environnement.
- [ ] **Step 3 : implémenter avec la stdlib, sans modifier le digest existant.** Le lanceur valide/normalise les données avant cet appel.

```ts
export function fingerprintConfiguration(
  input: { workspaceId: string; provider: "elevenlabs"; wpmPath?: string },
  secret: string,
): string {
  const descriptor = JSON.stringify([1, input.workspaceId, input.provider, input.wpmPath ?? null]);
  return `v1:hmac-sha256:${createHmac("sha256", secret).update(descriptor, "utf8").digest("hex")}`;
}
```

Ajouter `createHmac` à l'import existant. Ajouter les deux champs optionnels, sans changer les snapshots fournisseur. Le stockage sérialise déjà le run entier : ne pas écrire une migration ou une nouvelle couche de persistance.

- [ ] **Step 4 : ajouter le round-trip disque et l'archive sans champ.** Dans `calibration-storage.test.mjs`, utiliser `runFixture` et un répertoire temporaire : créer un run avec empreinte, rouvrir le store, comparer le champ ; créer une archive sans champ et vérifier que `get`/`list` la rendent sans ajout automatique.

```js
const identity = `v1:hmac-sha256:${"a".repeat(64)}`;
await store.runs.create({ ...runFixture, configurationIdentity: identity });
strictEqual((await createLocalStore(root).runs.get("local-default", "run-1")).configurationIdentity, identity);
await store.runs.create({ ...runFixture, id: "archive" });
strictEqual((await createLocalStore(root).runs.get("local-default", "archive")).configurationIdentity, undefined);
```

- [ ] **Step 5 : vérifier et examiner le diff.** Build puis `rtk proxy node --test test/calibration-domain.test.mjs test/calibration-storage.test.mjs`. Attendu : vert, y compris les valeurs golden de `fingerprintRequest`. `rtk git diff --check` et diff limité aux fichiers de cette tâche.

### Task 2 : configuration du lanceur, explicite et figée

**Files :** modify `src/calibration/entrypoint.ts`; reuse `src/calibration/credentials.ts`; test `test/calibration-entrypoint.test.mjs`.

**Interfaces :**

- Consumes: helper de tâche 1, `CredentialOptions`, `parseDotEnv`, `createCredentialProvider`, `findVaultRoot`.
- Produces: `CalibrationUiOptions.credentials?: Pick<CredentialOptions, "env" | "envFile">`, `wpmPath?: string` ; configuration snapshot interne au lanceur.
- Le lanceur passe `configurationIdentity` à l'application, un seul provider à ses trois consommateurs, et le chemin résolu au port canonique. La tâche 3 ajoutera le passage au pont.

- [ ] **Step 1 : tester refus et priorité via le lanceur public.** Utiliser un WPM temporaire `{}`, des clés de test et `t.after` pour fermeture/nettoyage. Ajouter ces cas : sources absentes hors `local-default`, fichier `.env` absent/sans clé, clé whitespace, `env`+`envFile`, credentials `null`/objet vide, WPM absent/JSON invalide/tableau/null, `workspaceId: null`. Rejeter avant création de fichiers du store ; conserver le test existant de découverte hors vault.

```js
test("explicit empty env file never inherits a global key", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "calibration-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".env"), "OTHER=value\n");
  writeFileSync(join(root, "wpm.json"), "{}");
  const saved = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "global-test-key";
  t.after(() => saved === undefined ? delete process.env.ELEVENLABS_API_KEY : process.env.ELEVENLABS_API_KEY = saved);
  await rejects(startVoiceCalibrationUi({
    workspaceId: "workspace-a", dataDir: join(root, "data"),
    credentials: { envFile: join(root, ".env") }, wpmPath: join(root, "wpm.json"),
  }), /credential|API key/i);
  strictEqual(existsSync(join(root, "data")), false);
});
```

Importer `rejects`, `existsSync` et le lanceur dans le fichier existant. Faire les changements d'environnement dans des tests non concurrents et restaurer leur valeur exacte.

- [ ] **Step 2 : constater le rouge.** Build puis `rtk proxy node --test test/calibration-entrypoint.test.mjs` ; vérifier que le refus attendu n'existe pas encore.
- [ ] **Step 3 : résoudre dans une fonction privée de `entrypoint.ts`.** Valider workspace avant discovery/I/O ; capturer `cwd` et environnement. Pour credentials explicites, vérifier exactement une source, lire le fichier unique avec `parseDotEnv`, extraire uniquement la clé non vide, puis créer le provider à partir d'un objet `env` neuf. Pour défaut historique, résoudre avec le provider existant puis reconstruire un provider snapshot à partir de son résultat (ou `{ env: {} }` si non configuré). Ne pas changer le loader historique.

```ts
const cwd = process.cwd();
const snapshotEnv = { ...process.env };
// Après validation/extraction de la source choisie :
const credentials = createCredentialProvider({
  env: secret === undefined ? {} : { ELEVENLABS_API_KEY: secret },
});
const configurationIdentity = secret === undefined ? undefined : fingerprintConfiguration(
  { workspaceId, provider: "elevenlabs", wpmPath }, secret,
);
```

`secret` est la valeur effectivement choisie ; `wpmPath` est `resolve(cwd, chosenPath)` ou absent en mode historique dégradé. Toute validation explicite échoue avant HTTP/MCP avec une erreur fixe sans contenu de fichier. Pour le JSON explicite : `readFile` + `JSON.parse`, refuser null/tableau/non objet et records de voix non objets ; accepter `{}` et `_default`. Réutiliser la forme canonique actuelle, ne pas recalculer les métriques.

- [ ] **Step 4 : vérifier deux instances via bootstrap.** Lancer A/B avec clés et WPM différents ; comparer `/api/v1/bootstrap.config.configured` et `observationSummary`, modifier ensuite les objets `env` et l'environnement global, vérifier l'absence de changement. Ajouter un lancement avec chemin relatif comprenant des espaces, en capturant/restaurer `cwd` dans un test non concurrent. Les bootstraps ne doivent effectuer aucune synthèse.

```js
const response = await fetch(`${ui.url}/api/v1/bootstrap`);
const bootstrap = await response.json();
strictEqual(response.status, 200);
strictEqual(bootstrap.config.configured, true);
strictEqual(JSON.stringify(bootstrap).includes("key-a"), false);
```

- [ ] **Step 5 : vérifier et examiner le diff.** Build + tests entrypoint ; garder `local-default` sans clé/source disponible avec `configured: false`/`sourceAvailable: false` lorsque les sources sont réellement absentes. Ne pas introduire de dépendance ni exporter une factory de configuration dans `src/index.ts`.

### Task 3 : chemin WPM et environnement jusqu'au child MCP

**Files :** modify `src/calibration/bridge.ts`, `src/calibration/entrypoint.ts`; test `test/calibration-bridge.test.mjs`.

**Interfaces :**

- `createCalibrationBridge` ajoute `wpmPath?: string`.
- `NodeMcpStdioTransport(command?: string, args?: string[], cwd?: string, launch?: { wpmPath?: string })` conserve ses trois arguments existants et capture l'environnement de base à sa construction.
- `createCanonicalProfilePort` ajoute `referenceBase?: string` pour conserver le nom historique lorsque le lanceur reconnaît cette source ; sinon référence URI fichier.

- [ ] **Step 1 : ajouter un vrai faux child stdio dans un répertoire temporaire.** Écrire ce contenu depuis le test dans `child.mjs` ; ne pas créer un fichier exécutable découvert par `node --test`. Importer `NodeMcpStdioTransport` déjà exporté.

```js
const childSource = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({
  key: process.env.ELEVENLABS_API_KEY, wpmPath: process.env.VOICE_WPM_PATH,
  other: process.env.CALIBRATION_TEST_MARKER,
}));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake", version: "1" } }
    : { tools: [{ name: "calibrate_voice", inputSchema: { type: "object" } }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`;
```

Construire le transport avec `process.execPath`, `[childPath, capturedPath]` et `{ wpmPath: pathA }`, changer l'environnement après construction, appeler `schema("key-a", 2000)`, lire la capture et fermer le transport dans `t.after`. Vérifier la clé choisie, le chemin exact, le marqueur capturé avant mutation et l'environnement parent inchangé. La capture n'utilise que des clés synthétiques et reste temporaire.

- [ ] **Step 2 : constater le rouge.** Build + tests bridge ; le child reçoit actuellement le WPM global, pas `pathA`.
- [ ] **Step 3 : adapter le transport et le wiring.** Copier `process.env` à la construction. Si `launch` est fourni, supprimer l'ancien `VOICE_WPM_PATH` puis poser l'override lorsqu'il existe. Au spawn, ajouter la clé obtenue du provider en dernier. Quand aucun `launch` n'est fourni, conserver le WPM capturé historique. Le pont choisit `launch` avec `Object.hasOwn(options, "wpmPath")` ; le lanceur transmet toujours cette propriété, même absente après discovery, pour empêcher un repli tardif.

```ts
const launch = Object.hasOwn(options, "wpmPath") ? { wpmPath: options.wpmPath } : undefined;
const transport = options.transport ?? new NodeMcpStdioTransport(undefined, undefined, undefined, launch);
```

Adapter ce snippet à la portée du constructeur existant, sans exposer un override générique d'environnement ni changer le protocole MCP. L'injection d'un faux transport reste possible. Conserver le contrôle de changement de clé, les erreurs emitted/non-emitted et `close`.

- [ ] **Step 4 : figer la source du port canonique.** Choisir une seule fois `wpmPath` à sa construction : propriété fournie = sa valeur, sinon défaut environnement capturé. Supprimer les défauts `process.env.VOICE_WPM_PATH` des trois lecteurs privés. Fournir `referenceBase` aux lecteurs de profil ; le lanceur choisit le nom historique uniquement si le chemin absolu correspond à la source du vault découverte, sinon `pathToFileURL(wpmPath).href`. Construire le fragment par `encodeURIComponent` et vérifier FR/EN.

```ts
const wpmPath = Object.hasOwn(options, "wpmPath") ? options.wpmPath : process.env.VOICE_WPM_PATH;
const referenceBase = options.referenceBase ?? (wpmPath ? pathToFileURL(wpmPath).href : undefined);
// Le résultat vérifié utilise :
const canonicalRef = `${referenceBase}#${encodeURIComponent(`${input.voiceRef}.${suffix}`)}`;
```

- [ ] **Step 5 : ajouter le test A/B du canonique et vérifier.** Créer A `{}` et B contenant un profil FR WPM 148 ; `findPublished` de A retourne null et `ensurePublished` de A refuse. B retourne la bonne URI fichier et le suffixe FR/EN. Changer le contenu de A ensuite : son résumé se rafraîchit, mais la source ne change pas. Mettre à jour seulement les attentes des tests dont les fichiers temporaires ne sont pas l'autorité historique. Build + tests bridge/entrypoint ; `rtk git diff --check`.

### Task 4 : garde de configuration sur les runs et lecture locale des archives

**Files :** modify `src/calibration/application.ts`, `src/calibration/ports.ts`, `src/calibration/http-server.ts`; test `test/calibration-api.test.mjs`, `test/calibration-e2e.test.mjs` et les fixtures du domaine/stockage si nécessaire.

**Interfaces :**

- Consumes: `configurationIdentity` de tâche 1, fournie par le lanceur de tâche 2.
- `ConflictError(message = "revision conflict", code = "conflict")` ajoute un champ `readonly code`, rétrocompatible ; `errorPayload` expose ce code, `statusForError` garde son mapping existant 409.
- Garde privée de l'application, pas d'option HTTP pour définir une identité.

- [ ] **Step 1 : adapter uniquement les factories de tests qui créent de nouveaux runs.** Fournir une identité fake valide dans `makeApplication` et les constructions E2E ; garder les fixtures explicitement historiques sans champ. Préserver la distinction entre propriété omise et `undefined` explicite pour tester le mode sans configuration :

```js
const TEST_IDENTITY = "v1:hmac-sha256:" + "a".repeat(64);
export function makeApplication(options = {}) {
  return createCalibrationApplication({
    ...options,
    configurationIdentity: Object.hasOwn(options, "configurationIdentity")
      ? options.configurationIdentity : TEST_IDENTITY,
  });
}
```
- [ ] **Step 2 : tester les quatre refus et la consultation.** Dans le fichier API existant, réutiliser `input`, `fakeBridge`, `fakeCanonicalProfilePort`, `makeApplication`, `publishCorpus` et `snapshotFiles`. Créer le run sous A, puis une application B utilisant les mêmes fichiers ; chaque opération doit refuser et aucune méthode de pont/canonique ne doit être appelée. Couvrir aussi un run sans champ, `running`, `execution_unknown` et un run core-backed (digest `v1:sha256:...`).

```js
const before = snapshotFiles(root);
const denied = makeApplication({
  repositories, bridge: forbiddenBridge, canonical: forbiddenCanonical,
  configurationIdentity: "v1:hmac-sha256:" + "b".repeat(64),
});
for (const operation of [
  () => denied.approve(run.workspaceId, run.id, { requestDigest: run.requestDigest }),
  () => denied.execute(run.workspaceId, run.id),
  () => denied.reconcile(run.workspaceId, run.id),
  () => denied.publishProfile(run.workspaceId, run.id),
]) await rejects(operation(), /configuration_mismatch/);
strictEqual((await denied.getRun(run.workspaceId, run.id)).id, run.id);
deepStrictEqual(snapshotFiles(root), before);
```

Dans ce test, définir `forbiddenBridge` avec les méthodes du pont faisant toutes `throw new Error("unexpected MCP")`, et `forbiddenCanonical.findPublished/ensurePublished` faisant `throw new Error("unexpected canonical")`. Pour tester `getBootstrap`, fournir seulement `getObservationSummary` lisant la source actuelle ou retournant un résumé fixe ; vérifier que le run historique reste inchangé.

- [ ] **Step 3 : constater le rouge.** Build + tests API ; vérifier que l'échec provient d'un accès au pont/canonique ou d'une absence de conflit.
- [ ] **Step 4 : ajouter la garde centrale et les conditions de lecture/recovery.**

```ts
private hasCompatibleConfiguration(run: CalibrationRun): boolean {
  return typeof run.configurationIdentity === "string" &&
    run.configurationIdentity === this.configurationIdentity;
}

private assertRunConfiguration(run: CalibrationRun): void {
  const code = run.configurationIdentity === undefined
    ? "configuration_identity_missing" : "configuration_mismatch";
  if (!this.hasCompatibleConfiguration(run)) throw new ConflictError(code, code);
}
```

Conserver l'option immuable dans le constructeur ; refuser une identité fournie mal formée. Dans `prepareDryRun`, exiger une identité avant `getSchema` et la persister sur le nouveau run. Copier `previous?.configurationIdentity` dans `projectCoreRun`, sans jamais remplacer une identité absente par celle de l'instance.

**Ordre impératif :** `getRun` lit d'abord le local et vérifie le workspace. Si identité absente/incompatible, retourner cette projection locale avant `ensureRecovered`, `bridge.getRun` ou `runs.save`. `recoverOrphanedRuns` ne transforme que les runs `running` à identité compatible. `getRunOrThrow` peut alors conserver son usage de `getRun`. Dans approve/execute/reconcile, appeler la garde immédiatement après obtention du run dans `withRunLock`, avant lookup canonique et pont. Envelopper aussi la publication dans le verrou de run existant, puis appliquer la garde avant lecture de rapport/bridge/canonique. Ne pas ajouter un verrou global.

Si une préparation retrouve localement un run existant, contrôler cette identité avant toute réutilisation ; ne pas écraser le run lors d'une collision d'ID retournée par le core. Le parcours actuel génère un ID neuf avant propose : ne pas créer un mécanisme de reprise par idempotence qui n'existe pas.

- [ ] **Step 5 : vérifier HTTP, projections et redémarrage compatible.** Tester 409 et `error.code` exact pour missing/mismatch, 200 pour GET/rapport, conservation de l'identité à chaque `projectCoreRun`, reprise des nouveaux runs à identité identique après réouverture du store, refus après changement de clé/chemin, et aucun effet après refus. Tester des identités falsifiées dans les corps HTTP : elles ne doivent jamais définir celle du run.
- [ ] **Step 6 : vérifier les garanties existantes.** Build + API/E2E/stockage/domaine. Ajuster les anciens tests de reprise dépourvus d'identité au comportement confirmé ; ne pas neutraliser les tests d'idempotence, de foreign workspace ou d'approbation consommée. `rtk git diff --check`.

### Task 5 : autorité WPM réelle du Python partagé

**Adaptation confirmée au préflight (2026-10-01) :** le runtime installé 0.2.0 importe `voice_calibration.mcp_server.server`. Sélectionner une fois `VOICE_WPM_PATH` à l'import du serveur, valider strictement toute valeur fournie, puis utiliser `dataclasses.replace` dans `_context_for_workspace` pour remplacer uniquement `context.state.corpus` et `context.state.runs_log`. Conserver `root`, gate, cache, secrets et verrous existants. Sans variable, conserver les chemins du contexte existant. Avec source historique, conserver `runs.jsonl` historique ; avec source personnalisée, utiliser `<chemin-wpm>.runs.jsonl`. `_publish_run` doit référencer la source réellement sélectionnée. Ne pas modifier les globals historiques de `voice_wpm.py`.

**Files :** dans le worktree vault, modify `Shared/voice-calibration/voice_calibration/mcp_server/server.py` ; create `Shared/voice-calibration/test_instance_wpm_paths.py` ; compléter au besoin `test_mcp_server.py`, `test_context_isolation.py` et `test_core_calibration.py`. Les tests existants sont à la racine du package. Aucun patch du vault principal.

**Validation adaptée :** subprocess distincts avec le Python 3.12 installé, corpus A/B et état temporaire ; vérifier les contextes réellement construits par le serveur, les lectures/writes de `log_run`, les chemins de verrouillage et la publication avec les mocks existants. Exécuter les tests depuis le worktree ; pour vérifier l'exécutable installé sans activation globale, utiliser un `PYTHONPATH` limité au processus vers ce package candidat et vérifier son `__file__`.

**Interfaces :** le child lit `VOICE_WPM_PATH` à son initialisation ; absence = autorité historique. L'override non historique utilise `<chemin-wpm>.runs.jsonl`. Les fonctions core existantes gardent leurs signatures.

- [ ] **Step 1 : ouvrir le worktree via le protocole vault existant.** Lire `rtk proxy vault-session --help`, puis `rtk proxy vault-session start` ; conserver le chemin retourné. Ne pas substituer un worktree créé manuellement au protocole. Si une autorisation de chemins est requise par le sandbox, présenter le lot concret avant l'escalade ; ne pas écrire hors des racines autorisées.
- [x] **Step 2 : tester le serveur MCP réellement importé.** `test_instance_wpm_paths.py` lance deux processus Python distincts avec des chemins A/B et vérifie, dans chacun, `server.__file__`, le corpus, le journal et la capture du chemin avant mutation de l'environnement. Les tests ciblés refusent les valeurs vides, les fichiers absents ou illisibles, le JSON invalide, les racines non objet et les records de voix non objet ; `_default` peut rester scalaire. Les tests en processus vérifient aussi les writes `log_run`, les lectures `get_wpm`, les verrous distincts, la publication et la référence du fichier personnalisé.
- [x] **Step 3 : constater le rouge et le vert.** Les dix cas initiaux ont échoué avant ajout des helpers ; les deux cas de records mal formés ajoutés lors de la revue ont échoué avant leur validation. La suite ciblée passe ensuite avec Python 3.12.10, `PYTHONPATH` limité au worktree candidat et `__file__` vérifié. Aucune synthèse réelle.
- [x] **Step 4 : adapter seulement le contexte MCP.** `server.py` capture et valide l'override à l'import ; `_context_for_workspace` construit le contexte existant, puis applique `dataclasses.replace` au contexte et à `StatePaths` pour ne changer que `corpus` et `runs_log`. `_publish_run` choisit une référence historique ou une URI de fichier avec fragment encodé. Les globals de compatibilité `voice_wpm.py`, les fonctions core, les verrous et les autres états restent inchangés.

- [ ] **Step 5 : prouver les writes autoritatifs, pas seulement les globals.** Étendre les tests actuels de `log_run`/`run_calibration` dont les signatures et fixtures ont été collectées au préflight : exécuter une observation simulée dans A, relever les bytes WPM/journal de A et de B ainsi que les fichiers historiques avant/après ; attendre modification de A seul. Faire l'inverse pour B. Utiliser les données d'observation et mocks de synthèse existants ; ne pas inventer des paramètres de `log_run` à partir de l'inventaire. Vérifier les lectures via `get_profile`/`get_wpm` et la publication core avec la fixture existante, dans ces deux environnements. Si ces tests/sources ne sont pas accessibles, cette étape n'est pas validée et la livraison demeure bloquée.
- [ ] **Step 6 : vérifier le runtime réel du child.** Relancer les probes avec le package effectivement exécuté par `voice-calibration-mcp` ; un test réussi dans un autre Python ne suffit pas. Consigner la vérification dans l'inventaire et le diff vault. Aucun ship du vault ni remplacement global du runtime sans l'autorisation correspondante.

### Task 6 : CLI, parcours final et documentation

**Files :** modify `src/calibration-cli.ts`, `test/calibration-autonomy.test.mjs`, `test/calibration-e2e.test.mjs`, `README.md`, `docs/calibration-architecture.md`, `docs/elevenlabs-calibration-contract-inventory.md`.

**Interfaces :** `--workspace-id` → `workspaceId`, `--env-file` → `credentials.envFile`, `--wpm-path` → `wpmPath` ; aucune clé CLI.

- [ ] **Step 1 : tester aide et configuration incomplète.** Réutiliser les imports `spawnSync`, `process.execPath` et `root` du test autonomie.

```js
test("CLI requires explicit sources for a named workspace", () => {
  const result = spawnSync(process.execPath, [
    resolve(root, "dist/calibration-cli.js"), "--workspace-id", "workspace-a",
  ], { encoding: "utf8", cwd: root });
  strictEqual(result.status, 1);
  match(result.stderr, /credential|WPM|source/i);
});
```

Ajouter les attentes des trois flags dans l'aide. Ajouter les valeurs manquantes de chacun et workspace invalide ; conserver help/version sans lancement.

- [ ] **Step 2 : constater le rouge puis adapter le parseur existant.** Étendre `Options`, `HELP` et les branches `valueFor` :

```ts
else if (arg === "--workspace-id") options.workspaceId = valueFor(args, index++, arg);
else if (arg === "--env-file") options.credentials = { envFile: valueFor(args, index++, arg) };
else if (arg === "--wpm-path") options.wpmPath = valueFor(args, index++, arg);
```

La validation reste centralisée dans le lanceur ; ne pas dupliquer la discovery dans le CLI. Préserver les erreurs de port et les flags existants.

- [ ] **Step 3 : smoke CLI réel sans synthèse.** Dans le test autonomie, démarrer le CLI avec `spawn` (pas `spawnSync`) et des fichiers `.env`/WPM temporaires ; attendre son URL stdout, lire bootstrap et HTML/client servis, puis terminer le child et attendre sa fermeture. Vérifier le workspace à travers les requêtes HTTP existantes, le résumé propre à cette source et l'absence de clé dans stdout/stderr/bootstrap. Utiliser `t.after` pour terminer/nettoyer même après assertion échouée ; ne pas arrêter un listener externe.
- [ ] **Step 4 : compléter E2E HTTP avec fake bridge.** Même corpus, même workspace et fichiers, mais nouvelle identité après redémarrage → 409 sur les quatre mutations, 200 sur lecture et rapport, bytes inchangés. À identité identique, le parcours dry-run → approbation → exécution → publication réussit et conserve l'identité. Modifier uniquement le contenu WPM ne bloque pas le run.
- [ ] **Step 5 : documenter le résultat effectivement prouvé.** README : exemples de flags, défaut `local-default`, absence de repli explicite, freeze/redémarrage, deux sources obligatoires, archives consultables seulement. Architecture : identité hors digest fournisseur, gardes et lecture locale, child par instance. Inventaire : version/source Python vérifiée, override, journal/verrous et limites des états gate. Ne pas marquer la fonctionnalité complète si tâche 5 non validée ; ne pas modifier CapCut.
- [ ] **Step 6 : validation finale, une fois.** Depuis le worktree Node :

```bash
rtk npm run build
rtk npm run typecheck
rtk npm test
rtk npm run lint
rtk git diff --check
rtk git status --short
```

Attendu : build/typecheck/tests/lint verts ; seuls les fichiers du lot sont modifiés. Côté Python, tests de chemins et tests core avec mocks verts dans le runtime réel. Refaire seulement les checks concernés si une correction devient nécessaire. Ne pas ouvrir une calibration réelle pour valider les credentials.
- [ ] **Step 7 : revue du résultat et remise.** Examiner le diff complet et les cinq Review Focus. Présenter les preuves Node/Python, les limites encore observées et les deux diffs si le lot partagé a été modifié. Commits/intégration uniquement dans le périmètre ensuite autorisé ; utiliser `git-push-clean` pour une intégration poussée et suivre ses contrôles de nettoyage.

## Auto-revue du plan

| Exigence de la spécification | Couverture |
|---|---|
| Credentials stricts, snapshot, deux instances, defaults historiques | Tâche 2 |
| Même clé pour application/annuaire/pont, pas de clé en arguments | Tâches 2 et 3, tests bridge existants conservés |
| WPM identique côté Node/child, defaults figés et références exactes | Tâche 3 |
| Identité backend hors requestDigest, persistance et archives | Tâches 1 et 4 |
| Garde sur reprise, GET core-backed sans mauvaise autorité, recovery | Tâche 4 |
| Python réellement compatible, writes/journal/verrous | Préflight et tâche 5 vérifiés : 151 tests Python pertinents et smoke du MCP réel avec package candidat |
| CLI, HTTP 409, docs, suite complète | Tâche 6 |

Plan validé puis exécution par sous-agents autorisée le 2026-10-01. Le préflight Python a confirmé les signatures et le contexte réellement utilisés ; la tâche 5 a été ajustée à ces sources. Le ledger local `.superpowers/sdd/2026-10-01-instance-configuration-plan/progress.md` consigne les checks et revues. L'activation globale du package Python reste distincte de la vérification locale du candidat.

## Remise pour choix d'exécution

Faire relire ce plan et obtenir le choix avant implémentation :

- **Subagent-driven — recommandé :** un agent implémente une tâche, un reviewer distinct la vérifie avant la suivante, puis revue globale. Les tâches partagent leurs interfaces : les exécuter séquentiellement, sans writers concurrents. Les erreurs de configuration peuvent orienter une publication vers la mauvaise source ; les revues intermédiaires sont utiles.
- **Native :** implémentation par l'agent courant, puis une revue indépendante de l'ensemble. Moins de contextes/revues, avec les mêmes gates et validations.

Après choix, utiliser le skill correspondant et un worktree isolé pour l'exécution. Le choix d'exécution n'autorise ni synthèse payante, ni déploiement, ni modifications directes du vault principal.
