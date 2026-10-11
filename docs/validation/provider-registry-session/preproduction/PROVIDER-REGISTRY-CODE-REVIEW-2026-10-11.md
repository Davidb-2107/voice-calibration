# Revue du registre fournisseur — 2026-10-11

Périmètre confirmé : changements locaux depuis HEAD, nouveaux fichiers compris, dans les deux worktrees et la préproduction. API : `2349c19621239d9d15467134dd772b8c7f7317ac`. Python : `1793550695d73b852f4829793278f23dae6ccd29`. Aucun nouveau commit dans ce lot ; comparaison des fichiers suivis via `git diff HEAD`, lecture explicite des nouveaux fichiers.

## Standards

- **P2 — Installation possible pendant une exécution active.** [install_provider_registry.py:22](install_provider_registry.py) vérifie l'absence de propriétaire une seule fois. Les lignes 67–75 construisent l'image puis remplacent application et configuration sans verrou exclusif conservé pendant l'installation. Si l'API démarre pendant le build, l'installation continue et peut laisser le service actif sur une autre version que celle déclarée. Reproduction isolée : `temp/review_registry_installer_race.py`, Docker simulé créant `owner.lock` pendant le build ; remplacement de l'application et de la configuration confirmé malgré ce propriétaire. Réutiliser le protocole de verrouillage exclusif de la restauration.

- **P2 — Séparation clé/registre contournable avec `..`.** [provider_registry.py:31](../work/supabase-tenant-adapter/Shared/voice-calibration/voice_calibration/core/provider_registry.py) utilise `Path.absolute()`, qui conserve les segments `..`. Les comparaisons des lignes 42–43 et 53–54 sont donc lexicales. L'initialisation accepte `directory=root/registry`, `key=root/alias/../registry/key`, alors que la clé résolue appartient au registre inscriptible. Reproduction isolée : `temp/review_registry_paths.py`, résultat `key_in_writable_registry=True`, `initialization_accepted=True`. Normaliser les chemins après contrôle des liens et tester ce cas. Les chemins fixes actuellement déployés ne déclenchent pas ce défaut.

Aucune violation documentée supplémentaire ni odeur Fowler justifiant une correction retenue.

## Spec

- **P2 — Réconciliation fournisseur non raccordée au parcours opérationnel.** Exigence de [l'audit, ligne 75](PROVIDER-REGISTRY-AUDIT.md) : « Raccorder une lecture fournisseur à la réconciliation uniquement avec identité et droits validés ». Le helper `reconcile_provider_history()` n'a aucun appelant opérationnel : seulement ses tests et sa copie Docker. [MCP `reconcile_calibration`, ligne 605](../work/supabase-tenant-adapter/Shared/voice-calibration/voice_calibration/mcp_server/server.py) appelle toujours [gate `reconcile`, ligne 566](../work/supabase-tenant-adapter/Shared/voice-calibration/voice_calibration/core/approval_gate.py), qui retourne uniquement l'état enregistré. Même avec des identifiants fournisseur disponibles, le parcours existant ne collecte pas les preuves de l'historique. Raccorder explicitement le helper avec les contrôles d'identité et de droits déjà prévus, sans replay automatique.

- **P2 — Restauration du registre indépendant non validée.** Exigence de [l'audit, ligne 74](PROVIDER-REGISTRY-AUDIT.md) : « sauvegarde ou réplication séparée des données utilisateur ; tester coupures et restaurations du registre lui-même ». Les tests couvrent les interruptions de processus et l'export SQLite ; [le test d'export, ligne 153](../work/supabase-tenant-adapter/Shared/voice-calibration/test_provider_registry.py) ne restaure pas le stockage actif dans un volume neuf avec sa clé. Il manque un scénario de restauration des preuves suivi d'une tentative d'exécution et d'une restauration des données utilisateur, vérifiant le maintien du blocage. Cette limite est correctement déclarée dans [le rapport, ligne 86](PROVIDER-REGISTRY-IMPLEMENTATION.md).

Aucune extension hors périmètre identifiée.

## Vérifications effectuées pendant cette revue

- Deux analyses indépendantes : Standards et Spec.
- Lecture du diff local, des nouveaux modules, appelants, tests et scripts de déploiement.
- Deux reproductions isolées, sans modification du runtime persistant.
- `test_provider_registry.py` et `test_provider_history.py` : **19 PASS**, 19,80 s, avec le venv déclaré `wiki-claude` et un répertoire temporaire dédié.
- Aucun correctif appliqué au code métier, aucun appel fournisseur, commit ou push.

**Bilan : Standards 2 constats P2, dont la course d'installation ; Spec 2 exigences partielles P2, dont la réconciliation non raccordée. Aucun P1 retenu dans cette revue.**

Les suites complètes et la CI n'ont pas été relancées pendant cette revue ; les résultats précédents ne constituent pas une validation de ces quatre points. Les coupures matérielles, la lecture ElevenLabs réelle et la protection contre un moteur compromis restent non validées.
