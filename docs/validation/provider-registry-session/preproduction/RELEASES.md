# Releases locales et preuves de validation

Pour préparer ou activer une API de préproduction simulée, utiliser `release.py`, avec un `--root` pointant vers l'instance réelle.

```text
python release.py stage --source <checkout-api> --root <instance-preproduction> --base-commit <sha>
python release.py check --release <chemin-retourne>
python release.py activate --root <instance-preproduction> --release <chemin-retourne> --evidence <rapport-retourne>
python release.py status --root <instance-preproduction>
```

`stage` reconstruit et contrôle le lint, puis fige `dist` et `package.json` dans un dossier neuf. `check` teste le même contenu compilé : tests Node, première activation sur HTML réellement servi avec Playwright déclaré, publication et preuves avec le SDK Python déclaré ci-dessous. Une modification du build pendant ces tests invalide la preuve.

Les rapports ont des noms uniques par exécution. Chacun référence releaseId, empreinte du contenu compilé et module exact. L'activation refuse une ancienne preuve, une preuve partielle ou un module modifié. `status` lit la configuration active et vérifie sa preuve ; ce n'est pas une copie documentaire d'un état dynamique.

L'activation conserve l'image Docker, tous les bindings de workspaces, données, secrets et registres indépendants. Elle arrête proprement l'API, sauvegarde les trois ressources et la configuration, publie sous les claims existants puis redémarre via `control.py`. Seul `updatedAt` des entrées de file est neutralisé lors de la comparaison métier ; leurs autres champs sont comparés. Le watchdog utilise la pause déclarée par `control.py stop`.

Un échec pendant la publication conserve les claims. La reprise exige une réconciliation de cette installation ; un redémarrage n'autorise pas à effacer les claims ou à rejouer une opération.

## Nouveau workspace

Préparer ses répertoires, garde et registre vide. Construire la configuration candidate, puis appeler `install_provider_registry.install(candidate)`. Le validateur s'exécute avant les claims ; le publisher conserve les bindings existants et interdit le déplacement des ressources propriétaires de la file. Ne pas appeler `validate` depuis une publication déjà sous claims.

Ce module n'envoie aucune invitation et n'effectue aucune synthèse. Le provisionnement Auth et l'appartenance restent des opérations séparées ; une invitation ne doit pas être renvoyée au seul motif qu'une activation locale a été interrompue.

## Contrôles reproductibles

Le dépôt déclare Playwright comme dépendance de développement depuis le 13 octobre 2026 pour le test de première activation. Installer son Chromium avec `npx playwright install chromium` (Linux CI : `--with-deps`). Le test utilise uniquement des routes Auth fictives et aucun compte réel.

L'opérateur exige Python **3.12** avant tout import métier. La CI sélectionne **3.12.10** et crée un venv neuf, sans dépendances globales ni installation éditable. Les tests de publication utilisent le vrai SDK `voice-calibration` (0.2.0), sa dépendance interne `tiktok-spec` (0.1.0), leurs dépendances déclarées et les contraintes du SDK. `requirements-ci.txt` est l'entrée d'installation de cette validation ; `pytest` vient de l'extra `[test]` du SDK.

Le workflow fixe le checkout privé `Wiki_Claude` à **027f6af88f852ea5c7e2832035fbcc0142c5ac7f**, sous `.scratch/ci-sdk`, limité aux deux packages. Ce SDK n'est pas publié sur PyPI. La CI service requiert le secret `VOICE_CALIBRATION_VAULT_READ_TOKEN`, limité à **Contents: read** sur ce seul dépôt privé. Le token n'est pas conservé dans le checkout. Ne pas copier le code privé ou un jeton utilisateur dans ce dépôt public. Un secret absent fait échouer la préparation explicitement ; aucune fausse implémentation SDK ne remplace les assertions.

Depuis un export neuf du service, préparer le checkout SDK à cette révision avec l'accès privé autorisé, puis exécuter depuis la racine :

```bash
python3.12 -m venv --copies /tmp/p03-operator
python3.12 -m venv --copies --without-pip /tmp/p03-peer312
/tmp/p03-operator/bin/python -m pip install --no-cache-dir -r requirements-ci.txt
/tmp/p03-operator/bin/python -m pip check
P03_PY311=/chemin/python3.11 P03_PY314=/chemin/python3.14 \
P03_PEER_PY312=/tmp/p03-peer312/bin/python P03_RUNTIME_RECORD_DIR=/tmp/p03-runtime-evidence \
  /tmp/p03-operator/bin/python -I -B -m unittest discover \
  -s docs/validation/provider-registry-session/preproduction -p 'test_release*.py' -v
/tmp/p03-operator/bin/python -I -B -m pytest \
  docs/validation/provider-registry-session/preproduction/test_new_lock_recovery.py -q
```

Les interpréteurs réels 3.11 et 3.14 sont fournis pour les contrepreuves CLI, import de bibliothèque et lecteur Node. Chaque refus vérifie l'absence d'import métier et de démarrage. Le lecteur positif 3.12 rapporte son interpréteur, et les tests du second 3.12 vérifient qu'une relance ne peut changer d'exécutable. La CI conserve les JSON de ces observations. Les exécutables du venv sont copiés : deux liens symboliques vers le même interpréteur ne prouveraient pas ce refus.

La CI exécute aussi les contrôles Node/build et le scénario navigateur. Les tests historiques d'intégration du registre demandent encore le moteur de calibration du harness. Ces commandes de validation utilisent uniquement des autorités et modules synthétiques, sans appel fournisseur ni intervention sur l'installation.
