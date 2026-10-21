# Corpus de voix partagé avec les projets TikTok

Le profil représente une configuration immuable : fournisseur, voix, modèle, réglages effectifs, langue et protocole CUT/atempo. Son ID est calculé par le moteur Python à partir de cette configuration, indépendamment des runs. Le corpus de ce profil évolue au fil des calibrations et des vidéos.

## Sélection à la création ou configuration

Le lanceur Windows du vault (`Shared/tiktok.py`) fournit désormais la session au client Python en mémoire et renouvelle ses tokens avant les requêtes, sans token dans les arguments, les fichiers projet ou l'environnement des sous-processus. La connexion du navigateur SaaS ne connecte pas ce lanceur. Sa procédure complète, les prérequis et la portée/suppression du coffre Windows sont décrits dans `Shared/voice-calibration/docs/tiktok-launcher.md` du dépôt Wiki_Claude.

Depuis la racine du vault avec le runtime prescrit par `DEV-ENV.md` :

```bash
python Shared/tiktok.py login --account personnel --api-url http://127.0.0.1:4317
python Shared/tiktok.py profiles --account personnel
python Shared/tiktok.py create --account personnel --name MonProjet --project-type mon_projet --slug pilote --voice-profile '<ID>'
python Shared/tiktok.py configure --account personnel --project-dir Projects/TikTok/MonProjet --voice-profile '<ID>'
python Shared/tiktok.py check --project-dir Projects/TikTok/MonProjet
python Shared/tiktok.py gate --episode Projects/TikTok/MonProjet/outputs/01-pilote
python Shared/tiktok.py logout --account personnel
```

Pour Neon_Psycho, ajouter `--keep-project-gate` à `configure`. Les commandes suivantes retrouvent le nom de connexion et la liaison vérifiée dans `_project/calibration-connection.json`, sans secret ni copie de corpus. Connexion, renouvellement et déconnexion n'exécutent aucune opération métier. La commande `produce --episode <épisode>` appelle le synthétiseur existant avec ses contrôles ; une synthèse incertaine reste bloquée et une mesure en attente est renvoyée seule.

URL HTTPS obligatoire, sauf en boucle locale. Aucun token, clé ElevenLabs ou chemin de stockage dans le projet. Le serveur résout le workspace depuis la session. Une expiration/révocation, une indisponibilité ou une différence de prédicteur bloque ; aucun repli vers le corpus local. La préproduction simulée permet de vérifier les sessions, mais ses profils restent exclus de la production.

Les points d'entrée directs suivants restent disponibles pour les intégrations existantes. Leur contrat bas niveau attend `VOICE_CALIBRATION_API_URL` et `VOICE_CALIBRATION_ACCESS_TOKEN` ; la fourniture manuelle d'un access token ne constitue pas le parcours utilisateur du lanceur.

- Lister les profils : `python Shared/voice-calibration/onboard_project.py --list`.
- Créer : `python Shared/scaffold_video_project.py --name MonProjet --project-type mon_projet --slug pilote --under tiktok --narration --voice-profile <ID>`.
- Configurer : `python Shared/voice-calibration/onboard_project.py --project-dir Projects/TikTok/MonProjet --voice-profile <ID>`.
- Pour Neon_Psycho, ajouter `--keep-project-gate`.
- Le bouton **Utiliser ce profil dans un projet TikTok** télécharge une petite référence `project-voice-reference-v1`. `--calibration-profile voice-profile.json` sélectionne cette même référence après vérification de la connexion et du workspace. Il ne copie pas de dataset.

`voice.json` conserve l’ID stable, l’alias et le workspace attendu. Les autres projets du même workspace réutilisent les mêmes observations. Les données de deux workspaces restent distinctes, même lorsque l’ID de configuration est identique.

Les anciens exports ponctuels sont remplacés par cette référence. Les profils historiques locaux restent utilisables par le mécanisme local existant ; ils ne deviennent pas automatiquement des profils partagés et les simulations ne sont jamais converties en données réelles.

## Circuit d’une génération

1. Lire une vue du corpus depuis `GET /api/v1/live-voice-profiles` avec authentification.
2. Utiliser cette même vue pour résoudre la voix, le gate, le budget et la prédiction avant la synthèse.
3. Conserver le profil, la révision, les identifiants des observations, le WPM, la bande et la durée prédite dans `audio/prediction.json`, puis `audio.json`.
4. Avant l’appel fournisseur, journaliser durablement son démarrage.
5. Mesurer RAW avant traitement, puis CUT après le traitement canonique strict. Les overrides et les échecs de traitement sont bloquants pour ce parcours.
6. Conserver une preuve de mesure dans `audio/calibration-observations/`, puis l’envoyer à `POST /api/v1/live-voice-profiles/<ID>/observations`.
7. Le moteur valide la configuration, le workspace, les empreintes, les durées et la prédiction contre la révision conservée. L’ajout et la mise à jour du corpus utilisent son verrou et son stockage atomique existants.
8. La commande suivante relit le corpus actualisé, sans réimport ni nouvelle sélection.

L’identité d’observation dépend des empreintes audio/narration dans le corpus du profil. Les réessais, requêtes concurrentes et réponses perdues ne créent pas de double mesure. Les outliers suivent la politique existante du moteur. Les calibrations futures de la même configuration rejoignent le même corpus ; les paramètres différents et les simulations ont des espaces de mesure distincts.

La V1 partagée utilise CUT et atempo 1. Le protocole `shared-audio-tools-cut-v1` doit changer si les paramètres du traitement changent. Le digest du prédicteur est vérifié avant synthèse et participe à la révision ; une ancienne preuve devenue incompatible reste bloquée pour réconciliation.

## Reprise et preuves

Une mesure en attente est renvoyée sans appel TTS. L’entrée de synthèse s’arrête après cette reprise gratuite. Une génération dont l’appel fournisseur a commencé sans mesure confirmée reste bloquée jusqu’à réconciliation ; aucun redémarrage ne vaut autorisation de payer à nouveau.

Le moteur conserve les datasets référencés dans `profile-snapshots/` du workspace persistant. Les historiques de générations et la boîte d’envoi locale doivent aussi être sauvegardés. Une révision manquante ou altérée bloque la mesure.

Les mesures TikTok sont produites par l’adaptateur authentifié, avec FFprobe et les outils audio canoniques. Ce canal fait confiance à cet adaptateur pour la mesure ; il n’est pas une attestation cryptographique de facturation ElevenLabs. Aucun partage inter-tenant ni migration automatique des calibrations non attestées n’est introduit.
