# Instances MCP liées à un workspace nommé

Date : 2026-10-01. Périmètre autorisé : analyse validée dans cette conversation, puis implémentation.

## Contrat

- Les IDs restent canoniques : `^[a-z0-9][a-z0-9_-]*$`. `client-a`, `staging` et `production` ne nécessitent aucune modification du code ni allowlist de noms.
- Une instance HTTP et son enfant MCP servent un seul workspace, fixé au démarrage. L'autorisation Python réutilise `StaticWorkspaceAuthorizer`, avec un droit construit depuis la configuration ; les workspaces étrangers sont refusés avant toute I/O métier.
- Les workspaces nommés exigent une source explicite de credentials et un WPM valide. Les credentials et les chemins sont copiés au démarrage ; les contenus WPM restent relus.
- La racine MCP est sélectionnable avec `stateDir` / `--state-dir`. Pour un workspace nommé sans cette option, elle vaut `<dataDir effectif>/mcp`. Les variables héritées de gate/state ne la remplacent pas.
- Le contexte Python, les secrets injectés et les chemins de gate sont fixes pour le processus. Le journal suit le WPM sélectionné ; le cache et le state suivent le workspace sous la racine MCP. Les locks de fichiers suivent leurs fichiers respectifs.
- L'enfant acquiert un verrou OS de possession du workspace MCP et du workspace UI avant de servir les tools. Un propriétaire concurrent est refusé, même avec une autre racine MCP mais le même store UI. Un arrêt forcé libère les verrous OS.
- Node initialise et vérifie l'identité workspace/racine MCP de l'enfant avant d'ouvrir le serveur HTTP ou de récupérer des runs. Un échec ferme le transport.
- La perte de l'enfant propriétaire ferme aussi le serveur HTTP. Le transport d'une instance liée ne relance pas implicitement son enfant ; un redémarrage explicite est nécessaire.
- L'empreinte persistée inclut la racine MCP pour une instance liée. Les anciennes empreintes et le lancement implicite `local-default` restent reconnus ; aucun historique n'est réécrit. Changer la racine d'une instance liée bloque les mutations d'anciens runs.
- Le dry-run historique utilise le workspace et le contexte de son instance. Le constructeur de proposition respecte le schéma réel : `voice_id` est fourni et `dry_run` n'est pas envoyé à `propose_calibration`.

## Validation

Tests unitaires Node et Python, test interprocess de possession avec arrêt forcé, et test opt-in HTTP → MCP réel avec deux workspaces. Tous utilisent des credentials factices et des fichiers temporaires ; aucun appel fournisseur n'est nécessaire.

## Limites explicites

Ce contrat isole les instances locales configurées. Il ne fournit pas d'authentification réseau ni d'isolation OS entre utilisateurs. Le lancement HTTP historique implicite reste paresseux ; utiliser `--state-dir` pour activer son binding explicite. Une source WPM volontairement commune reste commune et utilise les mêmes locks d'écriture ; les noms de workspace seuls ne rendent pas deux chemins externes distincts.
