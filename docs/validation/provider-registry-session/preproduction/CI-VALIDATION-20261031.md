# Validation CI Python du service, 31 octobre 2026

Le garde reste inchangé : l'opérateur accepte uniquement Python3.12. La préparation CI sélectionne3.12.10 et installe les dépendances de validation dans un venv neuf. Ce correctif ne met pas à jour l'installation opérationnelle.

## Causes et correction

La CI précédente utilisait Python3.14 : son refus avant imports métier était correct. Elle ne préparait pas non plus le SDK Python importé par les tests. requirements-ci.txt déclare maintenant voice-calibration[test]0.2.0 et sa dépendance first-party tiktok-spec0.1.0, avec les contraintes du SDK. Les packages viennent du vault privé027f6af88f852ea5c7e2832035fbcc0142c5ac7f, fixé dans le workflow, et sont installés sans mode éditable. Aucune résolution de ces deux noms sur PyPI.

Le checkout privé requiert le secret CI VOICE_CALIBRATION_VAULT_READ_TOKEN, Contents:read sur Wiki_Claude uniquement. Le service est public. Le code privé et le jeton local ne sont pas ajoutés au dépôt. Le secret n'existe pas au moment de cette preuve : le vert distant reste à obtenir après sa configuration. Un secret absent provoque un refus explicite de préparation.

## Reproduction indépendante

Image Python3.12.10 officielle, venv --copies neuf sans site-packages système. Avant installation, pip25.0.1 est le seul paquet. Installation : python -m pip install --no-cache-dir -r requirements-ci.txt, puis pip check réussi. Dépendances déclarées uniquement ; aucun venv canonique, node_modules existant, SDK éditable ou paquet global emprunté. npm ci et l'installation Chromium sont aussi exécutés dans l'image jetable.

Le service est exporté depuis les blobs Git, avec les changements limités du correctif. Sous Windows, git archive applique core.autocrlf : deux essais CRLF ont révélé un écart de contexte Biome. Le dernier export impose core.autocrlf=false et core.eol=lf. Aucun fichier suivi du dépôt n'a été reformaté pour résoudre cet écart. Les essais sont conservés séparément.

Rejeu final dans un conteneur sans réseau : image sha256:1a5489706bd69dd034feda7e6da3de452ab6d55f2f47e5d07b160f1eff821bb8, conteneur p03-service-ci-repair-8fc08bfe6624489990fe92c53e483963. Node22.23.4. Les commandes intégrales, versions installées, empreintes des sources et journaux sont dans CI-VALIDATION-20261031.json.

| Contrôle | Résultat |
|---|---|
| npx biome ci . | PASS |
| npm run typecheck | PASS |
| npm run build | PASS |
| npm test | 334 PASS,12 SKIP conditionnels préexistants,0 échec |
| npm run test:browser | 1 PASS,0 SKIP |
| Python unittest test_release*.py | 51 PASS,0 SKIP |
| Python pytest test_new_lock_recovery.py | 9 PASS,0 SKIP |

Les 12 SKIP Node concernent les intégrations conditionnelles du moteur ; leurs noms exacts sont conservés dans le JSON. Ils sont distincts des trois tests POSIX ignorés sur Windows. Ces trois tests font partie des 51 tests exécutés et réussis ici.

## Contrepreuves explicites

Les véritables interpréteurs sont3.11.9,3.14.0 et3.12.10, pas des versions simulées. Les tests vérifient leur version avant de tester le refus. Les JSON conservent version, chemin et empreinte de l'exécutable.

- Python3.11 et3.14 : les7 entrées opérateur, l'import de bibliothèque release et le lecteur appelé par Node sont refusés. Les modules métier empoisonnés ne sont pas importés, leurs marqueurs restent absents, aucun démarrage métier.
- Python3.12 : le lecteur réel répond avec operatorVersion3.12.10 et operatorPython=/tmp/p03-operator/bin/python, le même exécutable que le parent.
- Second exécutable3.12, copié sous /tmp/p03-peer312/bin/python : refus avant récupération, démarrage ou arrêt. Le lecteur de statut ne lit aucune autorité.

Le runner valide22 observations requises, en plus des résultats de tests. Les JSON bruts restent sous .scratch/p03-integration/service-ci-repair-20261031/results-linux/runtime-evidence dans le workspace de qualification. Cette preuve est une observation de CI, pas un reçu financier signé.

## Limites

La CI distante sur le prochain SHA doit encore réussir. Son accès au SDK privé est un prérequis externe identifié. Les modules Windows de sécurité et les données financières n'ont pas changé. Aucun service installé, vrai droit ou clé opérationnelle modifié. Aucun fournisseur, dépense, activation financière, sauvegarde opérationnelle, fusion ou nettoyage.
