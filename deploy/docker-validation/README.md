# Bootstrap Linux — image de validation

Cette image exécute des tests puis s'arrête. Elle ne doit pas être exposée ou
déployée comme service SaaS. Le moteur/API existants sont démarrés par le harness
de test, avec fournisseur ElevenLabs simulé et credentials fournisseur factices.

## Entrées déclarées

- Images officielles Python 3.12.10 et Node 22.14.0 Debian Bookworm, fixées par digest.
- FFmpeg/ffprobe et certificats CA installés par apt dans Linux.
- Packages Python locaux tiktok-spec, shared-audio-tools et voice-calibration,
  extra test déclaré, contraintes requirements.lock.
- Dépendances Node du package-lock.json, installées par npm ci, puis build.
- Configuration Supabase et credentials des deux comptes de test via stdin uniquement.

La connexion Auth est effectuée depuis Linux. Le broker de test sur l'hôte lit
les credentials Windows existants et effectue la révocation/restauration de
l'appartenance sur le projet Supabase de développement. Aucune clé privilégiée
Supabase ni clé ElevenLabs n'est transmise au conteneur.

## Construction du contexte et exécution

Depuis le dossier de session parent, le script
`temp/docker_bootstrap_validation.py` construit un contexte minimal contenant
les sources des deux candidats et les fixtures nécessaires. Aucun node_modules,
venv, corpus de production, .env ou credentials ne vient de Windows.

Ce contexte possède les chemins génériques `node/`, `Shared/`, `Dockerfile`,
`.dockerignore` et `container-validation.py`. Pour construire manuellement un
contexte déjà préparé :

```bash
docker build --no-cache --platform linux/amd64 -t calibration-validation CHEMIN_CONTEXTE
```

L'orchestrateur réalise deux builds sans cache, lance chacun avec un utilisateur
non root, filesystem en lecture seule, capabilities retirées et trois tmpfs
privés. Il n'expose aucun port et ne monte aucun dossier Windows. Chaque exécution
teste les packages installés, MCP, audio réel, API, Auth/RLS, isolation et
BLOCK → PASS avec calibration simulée. Les conteneurs et l'image propre au test
sont supprimés entre les essais. Aucun nettoyage global Docker n'est lancé.

## Portée de la reproductibilité

Les versions Python/Node/FFmpeg/ffprobe et le graphe Python résolu sont comparés
entre les deux essais. Les deux images ont des digests de base fixes, mais apt
et toutes les dépendances transitives/de build ne sont pas snapshot-lockés.
Ce scénario vérifie la reconstruction fonctionnelle actuelle, pas l'identité
binaire garantie à une date future. Les versions choisies servent à cette
validation de compatibilité et ne sont pas une sélection finale de production.

Le provisionnement de Docker sur un serveur vierge, TLS/reverse proxy, collecte
de logs, supervision, secret manager de production et déploiement public ne
font pas partie de cette image. Aucun test n'autorise une synthèse payante.

## Résultat du 2026-10-09

Deux builds sans cache et deux exécutions PASS dans
`temp/docker-bootstrap-794add66` du dossier de session. Chaque exécution :
5 tests Python installés PASS / 0 SKIP, Node 180 PASS / 1 SKIP, Auth/RLS réels,
MCP/core, isolation applicative et BLOCK → PASS avec fournisseur simulé.
Python 3.12.10, Node 22.14.0, FFmpeg/ffprobe 5.1.9-0+deb12u1 ; mêmes 42
distributions Python résolues. Conteneurs et image supprimés, appartenances
restaurées. Aucun appel ElevenLabs, commit ou push.

Le test audio a été rendu portable au padding MP3 des builds FFmpeg, sans
changer l'algorithme. Il passe sous Linux et Windows ; aucune intégrité spectrale
ou comparaison échantillon par échantillon n'est revendiquée.
