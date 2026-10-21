# Profils publiés vers les projets TikTok

Le but de Calibration ElevenLabs est de fournir les voix et les mesures CUT utilisées par les projets vidéo,
dont Neon_Psycho. Une publication destinée à un projet est un dataset versionné, pas une constante WPM.

Après une calibration réellement exécutée et publiée, le bouton **Télécharger le profil pour un projet TikTok**
appelle `GET /api/v1/voice-profiles/<id>/export` dans le workspace authentifié. Le serveur exige un run réussi,
le traitement CUT, une publication existante, la configuration d’origine et une provenance `executionProvider`
réelle enregistrée à la préparation. Les simulations et les runs historiques non attestés restent bloqués,
même si le fournisseur courant est ensuite changé.

Le fichier `project-voice-calibration-v1` contient :

- un VoiceProfile complet et versionné : ID, fournisseur, voix, modèle, réglages, langue et atempo ;
- les observations CUT vérifiées du run concerné, sans chemins serveur ni credentials ;
- le WPM de publication et les références au workspace, au run et à la version du corpus ;
- une empreinte d’intégrité du contenu JSON.

L’enveloppe `project-voice-package-v1` transporte le JSON du dataset comme texte UTF-8 et l’empreinte de ce
texte exact. Cela évite que les différences de sérialisation numérique entre Node et Python invalident un profil intact.

Le scaffold Wiki_Claude accepte `--calibration-profile <fichier>` ; la commande `onboard_project.py` accepte
la même option pour un projet existant. L’import valide le fichier et les mesures avant écriture, puis inscrit
une seule fois la publication dans la source WPM de l’instance. Le projet conserve seulement son ID de profil
et son alias de corpus. `target_words.py`, le gate et `synthesize.py` utilisent le résolveur partagé existant.
Neon peut conserver son gate métier avec `--keep-project-gate`.

Les publications sont des versions explicites : une nouvelle calibration ne remplace pas silencieusement celle
d’un projet existant. Le fichier doit venir de l’application de confiance ; l’empreinte détecte la corruption,
elle ne constitue pas une signature d’authentification. Aucun chemin de projet fourni par le navigateur n’est
ouvert par l’API, et ce parcours ne déclenche pas de synthèse supplémentaire.
