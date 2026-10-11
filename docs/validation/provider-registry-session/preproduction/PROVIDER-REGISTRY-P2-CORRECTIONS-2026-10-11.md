# Corrections P2 du registre fournisseur — 2026-10-11

Quatre agents ont reçu chacun un constat ; l'orchestrateur a vérifié les changements, leurs appelants et leurs tests, puis regroupé la validation. Corrections locales, sans commit, push, déploiement ni appel fournisseur réel.

| P2 | Correction et vérification |
| --- | --- |
| Installation concurrente | `install_provider_registry.py` détient les claims exclusifs `restore.lock` et `queue/owner.lock` durant toute l'installation. Propriété vérifiée avant suppression au succès ; échec conserve les claims, propriétaire étranger préservé. Cinq tests dédiés couvrent démarrage concurrent, restauration, seconde installation, interruption et changement de propriétaire. |
| Clé dans le registre via `..` | `_unlinked()` normalise le chemin et vérifie les composants originaux et normalisés, pour ne pas masquer un symlink ou une junction. Les comparaisons clé/registre portent sur les chemins normalisés. Cinq tests supplémentaires couvrent contournement à l'initialisation et à l'ouverture, alias externe valide et liens dissimulés. |
| Réconciliation non raccordée | Le point d'entrée MCP existant accepte `lookup_provider=True` explicitement. Il valide le workspace, les identités de configuration et de credentials, ainsi que le run/digest des tentatives. La clé utilisée pour la lecture est celle utilisée pour valider son identité. Les décisions matching/partial/insufficient sont persistées ; run et approbation restent bloqués, aucun replay. Le comportement par défaut reste une lecture d'état sans requête fournisseur. |
| Restauration des preuves non validée | Nouveau test `test_provider_registry_recovery.py` : export signé, clé sauvegardée séparément, destruction de l'ancienne autorité, restauration en stockage neuf, réouverture et ancienne approbation utilisateur restaurée. Succès et réponse incertaine conservent les preuves sans nouvelle synthèse ni observation dupliquée. Sept restaurations invalides/incomplètes bloquent : clé absente/différente, base absente/tronquée/altérée, workspace ou tenant étranger. |

## Action explicite de réconciliation

Appel MCP `reconcile_calibration` :

```json
{"workspace_id":"<workspace autorisé>","run_id":"<run incertain>","lookup_provider":true}
```

Cela peut effectuer des GET d'historique avec les credentials validés. Aucune synthèse, publication automatique ou réactivation de l'approbation. Cette action n'a pas été lancée contre ElevenLabs pendant les corrections. Sans identifiant fournisseur conservé ou preuve suffisante, le blocage demeure.

## Validation

- Tests individuels : chemins 21 PASS ; réconciliation/gate/MCP 43 PASS et 3 ignorés ; restauration des preuves 9 PASS.
- Préproduction, installation, restauration et réconciliation : **23 PASS**, rejoués par l'orchestrateur.
- Vérification du diff Python : `git diff --check` PASS.
- La première suite globale a été perturbée par des invocations pytest simultanées : `conftest.py` impose un basetemp commun, même avec `--basetemp`. Les fichiers temporaires de tests se sont donc heurtés. Elle a terminé avec trois échecs et 511 PASS ; ce résultat contaminé n'est pas retenu comme validation.
- Suite Python complète rejouée exclusivement, sans autre invocation pytest : **514 PASS, 8 ignorés, 1 avertissement Pydantic préexistant**, en 345,50 s, code de sortie 0. Commande après l'interpréteur du venv `wiki-claude` : `-m pytest Shared/voice-calibration -q --tb=short`. Journal : `work/supabase-tenant-adapter/.scratch/provider-p2-final-python-tests.log`.

**Bilan : les quatre P2 sont traités et vérifiés localement. 514 tests du moteur et 23 tests de préproduction passent.**

## Limites

Les corrections ne sont pas encore incorporées à l'image de la préproduction persistante. Les copies de build et du runtime sont régénérées par l'installateur lors de la prochaine reconstruction ; le runtime actuel n'a pas été modifié.

La restauration testée ne garantit pas la fraîcheur d'un ancien export correctement signé : il peut manquer des opérations ultérieures. Ne pas remplacer une autorité active par cet export pour débloquer un run. Coupures matérielles, sauvegarde hors site, résistance à un moteur compromis et historique ElevenLabs réel restent non validés. La CI n'a pas été lancée et les tests Node n'ont pas été rejoués, aucun fichier API n'ayant changé dans ce lot de correction.
