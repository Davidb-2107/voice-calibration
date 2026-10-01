# Configuration locale par instance — credentials ElevenLabs et source WPM

**Date :** 2026-10-01  
**Statut :** validée par l'utilisateur le 2026-10-01 ; aucune implémentation effectuée.  
**Suite de :** [isolation locale des workspaces](2026-09-30-workspace-isolation-design.md).

## Objectif

Fixer au démarrage de chaque instance ses credentials ElevenLabs et sa source WPM canonique, puis transmettre cette même configuration aux modules Node et au MCP Python. Conserver le lancement et les données de `local-default`, et réutiliser le provider de credentials, le lecteur canonique et le transport stdio existants.

Une instance HTTP reste liée à un seul workspace. Ce travail ne constitue pas une authentification multi-utilisateur ni une garantie d'isolation de tous les fichiers internes du cœur Python.

## État constaté dans le dépôt

| Module | Fonctionnement actuel | Écart à traiter |
|---|---|---|
| `entrypoint.ts` | Valide `workspaceId`, compose l'application ; résout WPM depuis `VOICE_WPM_PATH` ou `findVaultRoot` | Aucune option publique pour credentials ou WPM |
| `credentials.ts` | `CredentialOptions` accepte déjà `env`, `envFile`, `cwd`, `vaultRoot` ; `parseDotEnv` est exporté | Le lanceur n'utilise aucune de ces options ; un fichier explicite sans clé peut reprendre la clé du processus |
| `createVoiceDirectoryProvider` | Reçoit le même `CredentialProvider` que le pont | Conserver ce partage pour utiliser le même compte partout |
| `createCalibrationBridge` | Injecte la clé dans les appels internes du transport, hors arguments MCP | Ne reçoit aucune source WPM |
| `NodeMcpStdioTransport` | Lance `voice-calibration-mcp`, hérite de `process.env`, surcharge `ELEVENLABS_API_KEY` | Le chemin découvert côté Node n'est pas transmis ; environnement global relu au lancement du child |
| `createCanonicalProfilePort` | Lit WPM, observations et profils ; vérifie les résultats de publication | Ses lecteurs ont encore un défaut `process.env.VOICE_WPM_PATH` ; `canonicalRef` contient toujours le chemin historique |
| CLI autonome | Expose stockage, bind, port et ouverture navigateur | N'expose pas encore `workspaceId`, credentials ou WPM |

L'[inventaire du contrat Python](../../elevenlabs-calibration-contract-inventory.md), capturé le 2026-09-02, décrit `WPM_PATH` et `RUNS_LOG_PATH` comme des fichiers voisins de `voice_wpm.py`. Le préflight du 2026-10-01 a depuis vérifié, via le runtime et les sources lues dans Obsidian, que le MCP installé est `voice-calibration 0.2.0`, entrée `voice_calibration.mcp_server.server:main` sur Python 3.12.10. Le parcours gated utilise `CalibrationContext` et `StatePaths`, construits à partir de `VOICE_CALIBRATION_STATE_DIR` ; il ignore actuellement `VOICE_WPM_PATH`. Le lot Python doit donc adapter ce contexte existant, sans modifier les globals de compatibilité de `voice_wpm`.

## Interface publique proposée

Étendre `CalibrationUiOptions` avec deux options, en réutilisant `CredentialOptions` :

```ts
credentials?: Pick<CredentialOptions, "env" | "envFile">;
wpmPath?: string;
```

`workspaceId`, `dataDir`, `host`, `port` et `allowNetwork` conservent leur rôle actuel. Exemple programmatique, avec une clé obtenue côté backend :

```ts
await startVoiceCalibrationUi({
  workspaceId: "atelier-a",
  credentials: { env: { ELEVENLABS_API_KEY: keyFromBackend } },
  wpmPath: "C:/calibration/atelier-a/voice_wpm.json",
});
```

Deux modes de credentials explicites : `env` OU `envFile`. Fournir les deux est une erreur ; un objet vide, `null`, un chemin vide ou une clé vide/après trim sont également refusés. Seule `ELEVENLABS_API_KEY` est extraite : les autres variables du fichier ou de l'objet ne sont pas injectées dans le MCP.

Pas de clé dans une option CLI, une URL, un formulaire, un snapshot de run ou un fichier de configuration versionné. Le chemin du `.env` est une référence locale ; le fichier reste hors Git.

## Résolution et compatibilité

| Situation | Credentials | Source WPM |
|---|---|---|
| `local-default`, options omises | Comportement existant : clé processus, puis découverte des `.env` | `VOICE_WPM_PATH`, puis découverte du vault |
| `local-default`, une source explicitement fournie | Cette source remplace seulement son défaut | L'autre source conserve sa résolution historique |
| Workspace différent de `local-default` | Source explicite obligatoire | `wpmPath` explicite obligatoire |
| Source explicite invalide ou inaccessible | Échec du démarrage, sans repli | Échec du démarrage, sans repli |

**Choix confirmé lors du brainstorming : les deux sources sont obligatoires pour tout workspace autre que `local-default`.** Une clé globale ou un WPM découvert dans le vault ne complète jamais une configuration explicite incomplète. Un opérateur peut choisir volontairement les mêmes credentials et le même fichier pour deux instances, mais doit les fournir à chacune.

Le workspace par défaut n'est choisi que si `workspaceId` est absent (`undefined`), comme aujourd'hui. Toute autre valeur continue de passer par `assertWorkspaceId`.

Résoudre les chemins relatifs par rapport au `cwd` capturé à l'entrée du lanceur, avant tout démarrage HTTP ou MCP. Ne pas les résoudre par rapport au `dataDir`, au `.env` ou au répertoire Python. Utiliser les fonctions standard de `node:path`. Transmettre au MCP le chemin absolu effectivement utilisé par Node.

Pour un `.env` explicite, lire uniquement ce fichier avec le parseur existant, valider la clé, puis construire le provider avec un objet `env` contenant uniquement cette clé. Cela utilise le comportement existant sans découverte de `createCredentialProvider({ env })` et évite d'ajouter un nouveau provider ou de changer les priorités de son usage historique.

La configuration effective est copiée au démarrage, y compris après découverte pour `local-default` : modifier ensuite l'objet fourni, `process.env` ou le fichier `.env` ne change pas les credentials de cette instance. Les priorités de découverte historiques restent identiques ; leur résultat est désormais fixe pour la durée de l'instance. La source WPM est un chemin fixe ; son contenu reste relu pour refléter les nouvelles observations et publications. Changer de configuration nécessite un redémarrage.

Pour le chemin WPM explicitement fourni, exiger un fichier JSON existant, lisible et compatible avec la structure déjà consommée par le lecteur canonique. Un objet vide est un corpus valide ; une voix absente n'est pas une erreur de configuration. Aucun fichier ni profil n'est créé automatiquement. Les refus d'accès, JSON invalide et racines non objet doivent être distingués d'un corpus vide.

Pour `local-default` sans configuration explicite, conserver le fonctionnement dégradé existant : absence de clé signalée par `configured: false`, absence de source signalée par `sourceAvailable: false`, publication refusée si le canonique n'est pas vérifiable.

## Propagation jusqu'au MCP

La résolution appartient au lanceur existant, avant la composition de l'application. Une fonction privée dans `entrypoint.ts` suffit ; aucun registre d'instances ni framework de configuration.

1. Valider le workspace et résoudre les sources.
2. Construire un seul `CredentialProvider`, partagé entre application, annuaire de voix et pont.
3. Fournir le même chemin WPM résolu au port canonique et au pont.
4. Le pont transmet ce chemin au transport stdio qu'il crée ; conserver l'injection d'un faux transport pour les tests.
5. Au spawn, le transport copie l'environnement nécessaire à l'exécution, applique le chemin WPM résolu, puis la clé obtenue du provider. Il ne modifie jamais `process.env`.

Le transport existant reçoit une option ciblée pour sa source WPM/environnement de lancement ; conserver les usages actuels de son constructeur et le nom de commande `voice-calibration-mcp`. Capturer son environnement de base à la construction pour éviter qu'un child lancé tardivement hérite d'une reconfiguration d'une autre instance.

Les deux valeurs de configuration restent hors des arguments `tools/call` : `ELEVENLABS_API_KEY` et `VOICE_WPM_PATH` sont des variables du processus enfant. Les arguments de workspace, les outils du gate et leurs contrôles existants restent identiques. Chaque instance possède son pont et son child ; fermeture et redémarrage restent gérés par le transport existant.

Les chemins explicites ne doivent jamais retomber sur un défaut global dans `readPublishedWpm`, `verifyWpmFile` ou `readObservationSummary`. Centraliser leur choix lors de la construction du port ; préserver le comportement sans options pour les usages historiques du port.

### Prérequis du Python partagé

Avant d'annoncer cette propagation opérationnelle, lire via Obsidian le MCP, `voice_wpm.py` et leurs appelants actuels ; vérifier aussi le package réellement lancé par la commande. L'injection d'une variable seule n'est pas une preuve que le cœur l'utilise.

Le support manquant confirmé au préflight nécessite une adaptation minimale du Python partagé, dans un lot distinct soumis au protocole `vault-session` :

- Dans `voice_calibration/mcp_server/server.py`, adapter `_context_for_workspace` en réutilisant `dataclasses.replace` sur le contexte et son `StatePaths` figés. Remplacer seulement `state.corpus` et `state.runs_log` ; conserver `root`, le stockage du gate et les autres chemins. Les lectures et writes de `voice_wpm` suivent déjà ces champs et `_state_locks(context)` verrouille déjà les deux chemins effectifs : ne pas réimplémenter ces mécanismes.
- Adapter aussi la référence retournée par `_publish_run` pour identifier la source effectivement sélectionnée. Sans override, conserver le comportement du MCP existant. Les règles suivantes décrivent le comportement de l'override fourni par le lanceur.

- `VOICE_WPM_PATH` sélectionne le fichier autoritatif dans le contexte du processus ; sans variable, conserver les chemins existants du contexte MCP. Le lanceur `local-default` fournit son chemin WPM découvert comme override, afin d'aligner cette lecture historique avec les writes du MCP.
- Toutes les lectures, observations, agrégations, publications et verrous utilisent cette même source. Ne pas ajouter de writer WPM Node.
- Pour la source historique, conserver `runs.jsonl` et les noms de verrous existants. Pour une source différente, utiliser `<chemin-wpm>.runs.jsonl` comme journal ; les verrous sont associés aux chemins des fichiers qu'ils protègent, avec le mécanisme de verrouillage existant. Deux fichiers WPM d'un même répertoire ne doivent pas partager involontairement leur journal ni leurs verrous. Vérifier les appelants et cette association lors de l'adaptation Python.
- Ne pas utiliser un fichier illisible ou une valeur vide comme signal pour revenir au WPM historique.
- Vérifier l'emplacement des autres états du gate Python ; cette étape ne les déclare pas isolés par la seule configuration WPM.

La livraison de cette étape exige un contrôle d'intégration sans synthèse payante démontrant que le Python lancé lit et écrit le fichier sélectionné, avec ses journaux/verrous associés. Un test du `spawn.env` côté Node est nécessaire mais insuffisant. Aucun changement Python n'est effectué par cette spécification.

## Références et reprise

Pour la source historique, conserver les `canonicalRef` existants et les profils de `local-default`, sans migration. Pour une source différente, la nouvelle référence doit identifier réellement le fichier sélectionné et la clé de profil : utiliser une URI fichier construite avec `pathToFileURL`, avec fragment encodé. Ne pas fabriquer une référence `Shared/voice-calibration/voice_wpm.json` pour un autre fichier.

Les chemins locaux peuvent ainsi apparaître dans les références des nouveaux profils, comme information de provenance ; ils ne sont pas des secrets ElevenLabs. Leur forme doit rester stable sur Windows et les chemins avec espaces. Les rapports historiques restent lisibles sans réécriture.

**Choix confirmé le 2026-10-01 : refuser automatiquement la reprise après changement de configuration.** Le rattachement persistant de chaque nouveau run à une identité de configuration fait donc partie de cette étape. Cette identité doit distinguer les credentials effectivement sélectionnés et la source WPM, rester stable lors d'un redémarrage à configuration identique et ne contenir aucune clé en clair. Le contenu WPM évolue normalement ; ses nouvelles observations ne constituent pas un changement de configuration.

**Approche confirmée : empreinte calculée côté backend, sans registre de configurations.** Ajouter une métadonnée `configurationIdentity` à chaque nouveau run, hors snapshot fournisseur et hors `requestDigest`. Le champ reste optionnel dans le lecteur pour accepter les archives historiques, mais obligatoire lors de la création d'un nouveau run.

Calcul proposé : `v1:hmac-sha256:<empreinte>`, avec `createHmac` de `node:crypto`. La clé HMAC est la clé ElevenLabs effectivement sélectionnée ; le message est un descripteur déterministe comprenant la version, le workspace, le provider et le chemin WPM absolu normalisé utilisé par Node et le MCP. Ne pas inclure le contenu WPM, le chemin du fichier `.env`, le port HTTP, le PID ou une valeur aléatoire : ces éléments ne définissent pas les credentials ou la source sélectionnée. À clé et source identiques, changer de mode de chargement des credentials ne bloque donc pas la reprise. Une rotation de clé la bloque, même si le compte ElevenLabs reste le même.

Ne persister que cette empreinte ; la clé demeure dans le provider. Ne pas modifier ni détourner `fingerprintRequest`, réservé au contrat de calibration. Capturer l'identité avant le premier appel MCP de préparation du nouveau run et la conserver avec celui-ci. Un contexte sans credentials ne peut pas créer de run reprenable ; le bootstrap historique sans credentials reste accessible. L'empreinte ne vérifie pas le contenu du fichier WPM et ne constitue pas une protection contre un opérateur modifiant volontairement les fichiers locaux.

Avant approbation, exécution, réconciliation ou publication, comparer l'identité du run à celle de l'instance. Effectuer également cette vérification lorsqu'une préparation retrouve un run existant par idempotence. Une différence retourne un conflit HTTP 409 `configuration_mismatch` avant appel MCP, lecture de publication canonique ou écriture. Ne pas réaffecter le run, modifier son approbation ni relancer sa synthèse. La consultation de ses données et rapports demeure possible dans son workspace. Garder cette identité distincte du `requestDigest` du contrat MCP.

Réutiliser le mécanisme de conflit de l'application et centraliser ce contrôle dans une fonction appelée par les opérations concernées, dans leurs sections protégées existantes. Ne pas l'ajouter au lecteur partagé de runs : celui-ci sert aussi la consultation autorisée. Ne jamais accepter l'identité envoyée par le navigateur comme preuve ; la création de run utilise uniquement l'identité calculée par le backend.

**Choix confirmé lors du brainstorming : les runs historiques sans identité de configuration restent consultables, mais leur reprise est bloquée.** Retourner un conflit `configuration_identity_missing` avant approbation, exécution, réconciliation ou publication. Ne jamais leur attribuer automatiquement l'identité actuelle. Leur configuration d'origine ne peut pas être déduite de la configuration actuelle ; leurs fichiers, rapports et références restent préservés, sans migration. Le lecteur de stockage doit continuer à accepter ces anciens runs pour la consultation. Un run historique à état d'exécution inconnu conserve cet état ; le refus ne vaut ni échec de synthèse ni autorisation de réexécution.

Deux instances peuvent sélectionner volontairement la même source WPM ; cela signifie qu'elles partagent cette autorité. Ne pas imposer une copie du corpus ni déduire le chemin du workspace. La séparation du stockage local déjà implémentée reste indépendante de ce choix.

## CLI et visibilité

Ajouter au parseur et à l'aide existants :

```text
--workspace-id <id>    workspace fixe de l'instance
--env-file <file>      credentials ElevenLabs de cette instance
--wpm-path <file>      source WPM canonique de cette instance
```

Exemple futur, depuis Git Bash :

```bash
node dist/calibration-cli.js --workspace-id atelier-a \
  --env-file C:/calibration/atelier-a/.env \
  --wpm-path C:/calibration/atelier-a/voice_wpm.json --open
```

Conserver les options et comportements du CLI actuel, notamment aide/version et bind local. Le lanceur programmatique reste l'interface commune ; l'adaptateur CapCut peut continuer à l'utiliser sans modification pour `local-default`. Son éventuelle exposition des nouveaux flags relève de son propre dépôt.

Réutiliser le bootstrap, le statut `configured`, le résumé WPM et la redaction existants. Pas de nouvelle page de settings ni d'endpoint pour changer la configuration en cours. Les erreurs de configuration sont nettoyées avant sortie CLI ; aucune clé, aucun contenu `.env`, ni environnement complet ne doit apparaître dans les erreurs, logs, réponses HTTP ou diagnostics MCP.

## Critères d'acceptation pour l'implémentation

1. Le lancement historique `local-default`, sa découverte hors vault, ses données, ses références et ses comportements dégradés restent compatibles sans migration. Les anciens runs et rapports sont lisibles ; les tests de reprise des runs sans identité sont ajustés au refus explicitement choisi.
2. Une configuration explicite gagne contre des valeurs globales contradictoires. Un fichier credentials absent/sans clé, une clé vide, un WPM absent/invalide et un workspace invalide échouent avant écoute HTTP, spawn MCP et appel facturable ; aucun repli caché.
3. Deux instances A/B dans le même processus utilisent leurs clés et leurs chemins respectifs, même si l'environnement global ou les objets appelants changent après démarrage. Tester aussi des lancements MCP différés et des chemins relatifs/avec espaces.
4. Annuaire de voix, statut et pont utilisent le même compte. Le child reçoit le chemin lu par le port canonique et uniquement la clé sélectionnée ; aucune clé n'est envoyée dans les arguments MCP ou exposée dans les diagnostics.
5. Le résumé, la recherche de profil et la vérification de publication lisent le WPM de l'instance. Un résultat présent seulement dans B ne peut pas valider une publication de A. Les références nouvelles pointent sur la bonne source ; les anciennes restent lisibles.
6. Le Python réellement lancé respecte l'override WPM sur ses lectures et écritures, conserve les défauts historiques et utilise les journaux/verrous associés. Vérification locale avec sources temporaires et synthèse simulée, sans appel ElevenLabs facturable.
7. Les nouveaux flags atteignent le lanceur ; les workspaces explicites incomplets sont refusés. Les contrôles workspace, approbation, idempotence, publication et reprise des nouveaux runs à configuration identique restent valides. L'identité persiste au redémarrage ; changer seulement le mode de chargement de la même clé ne la change pas. Un changement de clé ou de source WPM bloque approbation, exécution, réconciliation et publication avant toute opération du pont ou écriture ; une évolution du contenu WPM ne bloque pas la reprise. Une identité absente sur un ancien run produit `configuration_identity_missing`, sans migration automatique ni modification de son état. Les runs et rapports restent consultables.
8. Étendre les tests existants du lanceur, du pont/canonique et du CLI ; ajouter un faux MCP stdio pour vérifier l'environnement réel du child. Faire passer build, typecheck, suite du projet et lint après implémentation.

## Périmètre de réalisation

Principalement `entrypoint.ts`, `bridge.ts`, `calibration-cli.ts`, ainsi que le modèle de run, sa persistance et les contrôles de l'application pour l'identité de configuration ; étendre leurs tests et réutiliser `credentials.ts` et `redaction.ts`. Mettre ensuite à jour le README et l'inventaire avec des preuves actuelles. Le lot Python éventuel reste identifié séparément, mais sa compatibilité est requise pour terminer la fonctionnalité.

Hors de cette étape : gestionnaire de secrets, rotation à chaud, configuration éditable dans le navigateur, SaaS/authentification, routage de plusieurs workspaces dans une instance, migration de corpus, changement des métriques WPM ou du protocole de calibration, déploiement et modifications de CapCut.
