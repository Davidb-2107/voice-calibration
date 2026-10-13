# Releases locales et preuves de validation

Pour préparer ou activer une API de préproduction simulée, utiliser `release.py`, avec un `--root` pointant vers l'instance réelle.

```text
python release.py stage --source <checkout-api> --root <instance-preproduction> --base-commit <sha>
python release.py check --release <chemin-retourne>
python release.py activate --root <instance-preproduction> --release <chemin-retourne> --evidence <rapport-retourne>
python release.py status --root <instance-preproduction>
```

`stage` reconstruit et contrôle le lint, puis fige `dist` et `package.json` dans un dossier neuf. `check` teste le même contenu compilé : tests Node, première activation sur HTML réellement servi avec Playwright déclaré, publication et preuves avec la bibliothèque standard Python. Une modification du build pendant ces tests invalide la preuve.

Les rapports ont des noms uniques par exécution. Chacun référence releaseId, empreinte du contenu compilé et module exact. L'activation refuse une ancienne preuve, une preuve partielle ou un module modifié. `status` lit la configuration active et vérifie sa preuve ; ce n'est pas une copie documentaire d'un état dynamique.

L'activation conserve l'image Docker, tous les bindings de workspaces, données, secrets et registres indépendants. Elle arrête proprement l'API, sauvegarde les trois ressources et la configuration, publie sous les claims existants puis redémarre via `control.py`. Seul `updatedAt` des entrées de file est neutralisé lors de la comparaison métier ; leurs autres champs sont comparés. Le watchdog utilise la pause déclarée par `control.py stop`.

Un échec pendant la publication conserve les claims. La reprise exige une réconciliation de cette installation ; un redémarrage n'autorise pas à effacer les claims ou à rejouer une opération.

## Nouveau workspace

Préparer ses répertoires, garde et registre vide. Construire la configuration candidate, puis appeler `install_provider_registry.install(candidate)`. Le validateur s'exécute avant les claims ; le publisher conserve les bindings existants et interdit le déplacement des ressources propriétaires de la file. Ne pas appeler `validate` depuis une publication déjà sous claims.

Ce module n'envoie aucune invitation et n'effectue aucune synthèse. Le provisionnement Auth et l'appartenance restent des opérations séparées ; une invitation ne doit pas être renvoyée au seul motif qu'une activation locale a été interrompue.

## Contrôles reproductibles

Le dépôt déclare Playwright comme dépendance de développement depuis le 13 octobre 2026 pour le test de première activation. Installer son Chromium avec `npx playwright install chromium` (Linux CI : `--with-deps`). Le test utilise uniquement des routes Auth fictives et aucun compte réel.

La CI exécute build/tests, le scénario navigateur et `python3 -m unittest discover -s docs/validation/provider-registry-session/preproduction -p 'test_release*.py'`. Ces tests de publication sont autonomes ; les tests historiques d'intégration du registre demandent encore le moteur de calibration du harness.
