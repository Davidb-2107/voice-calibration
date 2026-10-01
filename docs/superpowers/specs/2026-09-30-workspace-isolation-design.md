# Isolation locale des workspaces — design

**Date :** 2026-09-30

**Statut :** implémenté, revu et fusionné dans `main` le 2026-10-01 via la [PR #4](https://github.com/Davidb-2107/voice-calibration/pull/4), commit `2910c6e`.

**Dépôt :** `voice-calibration`

## Objectif

Rendre cohérente l'identité du workspace dans le serveur HTTP, l'application et la persistance locale. Cette première étape prépare un futur SaaS multi-utilisateur tout en conservant le lanceur et les données de `local-default`. Elle ne rend pas le service actuel apte à être exposé à plusieurs utilisateurs.

## Constat initial avant implémentation

- Le serveur lisait `workspaceId` dans la requête pour certaines routes (`src/calibration/http-server.ts`), tandis que le client envoyait `local-default` dans le corps du dry-run (`src/ui/calibration-client.ts`).
- Les corpus et profils étaient rangés par workspace. Les chemins des runs et artefacts étaient fixés à `workspaces/local-default/` (`src/calibration/local-store.ts`).
- Les commandes sur un run recevaient son seul ID ; `CalibrationApplication` ne vérifiait pas que le run appartenait au workspace de la requête.
- Les tests couvraient le parcours local, mais pas l'accès croisé entre deux workspaces.

## Contrat du serveur local

Une instance du serveur est liée à un seul `workspaceId`, fixé au démarrage. La valeur par défaut reste `local-default`. L'option serveur existante `workspaceId` sert à choisir une autre valeur pour une instance ; le lanceur public transmet cette option sans ajouter de sélection dans l'UI ou de nouveau drapeau CLI.

Les IDs de workspace ont une forme canonique unique : caractères ASCII minuscules, chiffres, tirets et underscores, selon `^[a-z0-9][a-z0-9_-]*$`. Les variantes de casse sont rejetées, sans conversion silencieuse. Ce contrat évite que `workspace-a` et `WORKSPACE-A` soient traités comme deux identités alors que Windows les associe au même répertoire. La validation intervient avant toute I/O à l'entrée de l'application et des dépôts, y compris pour leurs appels directs. Une configuration de serveur invalide empêche son démarrage ; un ID invalide dans une requête reçoit `400 invalid_workspace_id`.

Le serveur fournit ce workspace à chaque appel portant sur des données de workspace, notamment aux opérations par ID sur les runs. Une requête qui contient un `workspaceId` égal à celui de l'instance reste acceptée pour compatibilité. Une valeur valide mais différente, dans l'URL, le corps direct ou un objet `input` ou `draft`, reçoit `400 workspace_mismatch` avant tout effet de bord. Le client navigateur cesse d'envoyer `local-default` dans le dry-run ; le serveur ajoute le workspace à l'entrée applicative.

Un ID de run absent du workspace de l'instance reçoit `404`, qu'il existe ou non dans un autre workspace. La vérification précède la reprise des runs interrompus, les appels au pont MCP, la lecture du rapport, l'exécution et la publication. Les contrôles locaux actuels d'origine, de nonce, de révision et de digest restent en place ; ils ne constituent pas une authentification SaaS.

## Application et ports

Toutes les opérations par ID sur un run prennent le workspace attendu : `getRun`, `getReport`, `approve`, `execute`, `reconcile` et `publishProfile`. Les helpers internes qui chargent un run propagent ce contexte. `getRun` effectue d'abord une lecture locale limitée au workspace et vérifie l'appartenance du run, sans effet de bord. Si le run est absent ou étranger, il retourne immédiatement l'absence, sans déclencher de récupération. Si le run appartient au workspace, `getRun` déclenche la récupération éventuelle des runs `running` de ce workspace, puis relit le run pour prendre en compte son état récupéré. `prepareDryRun` conserve un `workspaceId` fourni par le serveur et l'emploie pour le corpus, le pont et la persistance. La reprise déclenchée par `getBootstrap` reste limitée au workspace demandé.

Le pont MCP compare le workspace du `CoreRunRecord` retourné à celui de l'appel pour `propose`, `approve`, `getRun`, `execute`, `reconcile` et `publish`. Une réponse contradictoire est refusée avant projection, extraction de résultat ou persistance locale. En particulier, `publish` effectue ce contrôle avant de transformer le record en `PublicationResult`, dont le retour actuel ne conserve pas l'identité du workspace. Aucun profil local ni vérification canonique de publication ne doit suivre une réponse contradictoire. Ce contrôle porte sur la réponse : il ne peut pas annuler une publication ou une autre action déjà produite dans le cœur MCP externe.

Le contrat `CalibrationRunRepository` accepte le workspace pour `get`, `recoverRunning` et `consumeApproval`. `create` et `save` utilisent le `workspaceId` du run et ne rangent plus systématiquement le fichier sous `local-default`. `list` utilise déjà le workspace. Le contrat `ArtifactStore` reçoit le workspace lors de `put` et `get` ; son implémentation refuse toute référence hors du répertoire d'artefacts de ce workspace. L'application utilise le workspace du run pour enregistrer et relire son rapport.

Les IDs de run restent validés comme segments de chemin ; les IDs de workspace respectent le contrat canonique ci-dessus. Les verrous et écritures atomiques locaux restent en place. Cette étape n'ajoute pas de mécanisme de transaction distribué.

## Compatibilité des données et de l'UI

La disposition actuelle sous `workspaces/local-default/` et les références de rapport déjà enregistrées restent lisibles. Aucune migration ou copie de ces données n'est requise. Le lanceur sans option et l'UI actuelle continuent à ouvrir le même workspace et à suivre le même parcours de calibration. Les appels programmatiques qui envoyaient explicitement `local-default` restent acceptés ; ceux qui envoyaient un workspace différent à une instance liée à `local-default` reçoivent désormais l'erreur explicite ci-dessus. Un ancien nom de workspace non conforme au contrat canonique est rejeté ; il n'est ni normalisé ni renommé automatiquement.

## Critères d'acceptation validés

1. Un test utilisant `createLocalStore` crée corpus, runs, profils et artefacts dans deux workspaces et confirme que chacun est retrouvé uniquement dans le sien. Les doubles de dépôts utilisés ailleurs respectent aussi le workspace ; un stockage en mémoire qui l'ignore ne suffit pas à valider l'isolation.
2. Un test de collision de casse vérifie que `workspace-a` est accepté et que `WORKSPACE-A` est rejeté avant toute I/O. Il couvre la configuration du serveur, les entrées HTTP et les appels directs applicatifs ou de dépôts.
3. Un test HTTP lie une instance au workspace A et vérifie que lire, approuver, exécuter, réconcilier ou publier un run de B retourne `404` sans appel au pont MCP ni modification de fichier. Un `workspaceId` valide mais contradictoire dans l'URL ou un corps direct ou imbriqué retourne `400 workspace_mismatch`.
4. Le test de refus après redémarrage précrée un run `running` dans A et un run dans B, puis fait de la demande étrangère le premier appel à la nouvelle instance de A. Le `404` laisse les fichiers et l'état du run de A inchangés. Une lecture ultérieure autorisée dans A déclenche la reprise et retourne l'état récupéré.
5. Un faux transport MCP retourne une publication confirmée appartenant à un autre workspace. Le pont la refuse avant extraction ; aucune vérification canonique ni écriture de profil local ne suit. Les contrôles de workspace des autres opérations MCP sont également vérifiés.
6. Un parcours HTTP complet réussit dans un workspace canonique différent de `local-default`, avec un stockage local réellement partitionné. Les tests du parcours `local-default` et de reprise après redémarrage restent valides, y compris pour les rapports existants.
7. Les vérifications utilisent un faux pont ou un faux transport et de faux credentials ; aucun appel facturable à ElevenLabs n'est nécessaire.

## Réalisation et validation

Les trois tâches du [plan d'implémentation](../plans/2026-09-30-workspace-isolation-plan.md) sont terminées et ont fait l'objet de revues indépendantes. Les deux constats de la revue finale ont été corrigés et relus : `null` ne sélectionne plus silencieusement `local-default` au démarrage ; le pont rejette toute identité fournie invalide avant accès aux credentials ou au transport, y compris sur le chemin legacy.

Le résultat intégré a passé build, typecheck, lint et les 103 cas des tests du projet. La [CI du commit fusionné](https://github.com/Davidb-2107/voice-calibration/actions/runs/36825972573) a réussi sur un checkout propre, avec contrôle de formatage complet et `npm test` sans ciblage. Le bilan du plan documente séparément les deux scripts tiers sous `temp/` qui perturbaient la découverte automatique des tests dans le checkout Windows local.

## Hors périmètre

L'authentification, les autorisations, la base de données, le stockage objet, les workers, l'API publique du moteur, ainsi que l'isolation par compte de la clé ElevenLabs et de la source WPM canonique seront traités séparément. Le pont MCP et ces intégrations restent globaux dans cette étape. Une exposition SaaS exige de résoudre ces points avant déploiement multi-utilisateur.
