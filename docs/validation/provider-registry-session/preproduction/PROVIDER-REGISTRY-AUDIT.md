# Audit du registre fournisseur — 2026-10-11

## Conclusion

Le dispositif actuel est un contrôle de restauration avec quarantaine et archives indépendantes des sauvegardes ordinaires. Il ne constitue pas encore un registre permanent de chaque tentative fournisseur. Il convient de prolonger ce dispositif, plutôt que de créer un second mécanisme concurrent.

Périmètre : lecture du contrôle de restauration, de la réconciliation, du gate Python, du client HTTP et du moteur de calibration ; vérification de la documentation publique ElevenLabs ; tests gratuits existants. Aucun appel authentifié ElevenLabs, aucune synthèse, aucun déblocage, aucun commit ni push. Cet audit ajoute seulement ce document.

## Garanties constatées

| Exigence | État | Preuve / limite |
| --- | --- | --- |
| Bloquer une ancienne approbation restaurée | Couvert dans la préproduction configurée | Guard externe en lecture seule dans le moteur ; vérifié avant approbation/exécution. |
| Garder des preuves hors sauvegarde utilisateur | Partiel | `restore.py` archive les données présentes avant leur remplacement ; manifeste SHA256 pour les nouvelles captures. |
| Journaliser chaque tentative avant transmission | Manquant | Le gate consomme une approbation par run dans les données restaurables ; une calibration contient plusieurs POST. |
| Identité unique, workspace et autorisation pour chaque POST | Manquant | Identité/digest/configuration disponibles au niveau run, pas de liaison persistante externe par tentative. |
| Conserver les identifiants fournisseur | Manquant dans le résultat de calibration | Les headers reviennent de `_default_synthesize`, mais seul `character-cost` est exploité dans la boucle. |
| Empêcher une réactivation après rollback | Couvert par blocage global | La quarantaine empêche toute exécution ; aucune décision positive fondée sur un registre par tentative n'existe encore. |
| Détecter une modification d'une archive | Couvert contre modification isolée | Le manifeste est vérifié. Archive, manifeste et empreinte de référence restent modifiables sur le même poste. |
| Survie à la perte du poste/disque | Non démontré | Pas de réplication indépendante ni de test de perte complète du stockage des preuves. |
| Réconcilier une réponse ElevenLabs perdue | Non implémenté | `CalibrationApprovalGate.reconcile()` retourne seulement l'état conservé. |

### Les trois stockages à distinguer

1. Les runs du gate : état, approbation consommée, résultat et identité de configuration, dans `data/<workspace>/state/...`. Ils sont restaurables avec les données utilisateur.
2. `provider-receipts.jsonl` : fixture du fournisseur simulé, également dans les données utilisateur. Chaque ligne contient seulement `simulated` et un compteur `call`, réinitialisé pour chaque runner. L'écriture intervient après retour du fournisseur simulé. Ce fichier n'est ni un journal indépendant ni une preuve de facturation réelle.
3. `recovery/` et `data.before-restore-*` : contrôle indépendant de la restauration ordinaire. Il capture les preuves disponibles au moment d'une restauration contrôlée ; il n'enregistre pas les appels au fil de leur exécution. Une restauration hors procédure ou une perte des données avant capture ne sont pas couvertes par ces archives.

## Point prioritaire : erreur transport ≠ absence de facturation

Dans `core/calibration.py:475`, l'appel fournisseur est effectué ; un `requests.exceptions.RequestException` est intercepté à la ligne 555. Si aucun audio n'a été reçu, la ligne 576 retourne `status="error"`. Dans `core/approval_gate.py:542`, ce résultat devient `failed`.

Un timeout de lecture après envoi peut donc produire un état `failed` bien qu'une synthèse ait été effectuée côté fournisseur. Le même problème d'interprétation existe si la réception échoue après une partie du corps, ou si le traitement local échoue après réception. `runs_synthesized == 0` signifie absence de réponse exploitable reçue, pas preuve d'absence d'exécution fournisseur.

Le gate conserve l'approbation consommée : cela ne démontre pas une répétition automatique actuelle. En revanche, le statut est insuffisant pour une réconciliation financière ou pour autoriser une nouvelle tentative en concluant que l'ancienne n'a rien coûté. Il faut conserver séparément l'état de l'appel fournisseur et l'état du traitement audio/publication.

Le client `core/egress.py:128` n'installe pas de retry automatique de POST dans son chemin par défaut. Il suit néanmoins les redirections en conservant méthode et payload (`143–152`) ; ce comportement devra être explicitement contrôlé pour les appels payants, plutôt que de les traiter comme des lectures ordinaires.

## Durabilité et intégrité

`restore.py:22` écrit dans un fichier temporaire, appelle `flush`/`fsync`, puis `os.replace`. Cela protège contre une écriture partielle du contenu. Cela ne prouve pas la durabilité des renommages après coupure électrique : aucune synchronisation explicite des métadonnées du répertoire ni test de panne du poste n'est présent.

Les empreintes détectent une corruption ou une modification isolée. Elles ne rendent pas les preuves authentiques ou immuables : un acteur ayant accès en écriture à l'ensemble peut remplacer les archives, les manifestes et leurs empreintes. Une suppression des preuves ne constitue jamais une preuve d'absence d'appel. La quarantaine doit donc rester active en cas de preuve absente, ancienne ou incohérente.

## Possibilités ElevenLabs et leurs limites

La documentation officielle expose une liste paginée d'historique, avec filtres voix, modèle, texte et dates : [Get generated items](https://elevenlabs.io/docs/api-reference/history/list). Un élément peut contenir `history_item_id`, `request_id`, voix, modèle, paramètres, texte et changements de compteur : [Get history item](https://elevenlabs.io/docs/api-reference/history/get).

Ces données peuvent fournir une preuve positive d'une génération et permettre de récupérer un résultat existant. Leur raccordement au registre local n'est pas implémenté. L'absence d'un élément ne doit pas être interprétée comme absence de facturation ; les champs voix/texte/date ne garantissent pas une correspondance unique entre deux demandes identiques.

La route TTS auditée est [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert). Les paramètres `previous_request_ids`/`next_request_ids` concernent la continuité audio et ne constituent pas une clé d'idempotence. Aucune garantie de déduplication par identifiant client n'a été établie pour le chemin utilisé. Si aucune réponse ne parvient au client, des identifiants transmis dans cette réponse ne peuvent pas, à eux seuls, résoudre l'ambiguïté.

Une consultation réelle de l'historique nécessitera une autorisation de lecture distincte et les droits du compte fournisseur concerné. Cet audit a seulement consulté la documentation publique.

## Vérifications réalisées

Commande :

```text
C:/Users/dbele/.codex/venvs/wiki-claude/Scripts/python.exe -m pytest preproduction/test_restore.py preproduction/test_reconcile.py -q --basetemp temp/registry-audit-pytest
```

Résultat : **11 tests PASS**. Couverture : restauration, verrous, manifeste incorrect, interruptions simulées, preuve manquante/ancienne, identité divergente, archive altérée, conservation du blocage et absence de modification des guards.

Le rapport de réconciliation existant a été relu : **6 runs**, tous `insufficient_independent_proof_keep_blocked`, car leurs archives sont antérieures aux manifestes de capture. Ces captures ne peuvent pas devenir rétroactivement des preuves fiables. Le rapport ne confirme aucune facturation ; aucun nouvel audit fournisseur authentifié n'a été exécuté.

Une première commande de découverte `unittest` n'a trouvé aucun test ; le résultat de validation est celui de pytest ci-dessus.

## Plus petit prochain lot

1. Corriger la sémantique des erreurs après transmission : état fournisseur incertain distinct de l'échec local ; conserver le blocage sans nouvelle dépense automatique.
2. Étendre le registre externe existant avec une réservation durable et unique **avant chaque POST**, liée au tenant/workspace, run, autorisation, configuration/identité des credentials et empreinte de la demande. Aucun secret brut dans le registre. Une interruption entre réservation et transmission reste incertaine tant qu'aucune preuve ne permet de conclure.
3. Y conserver les transitions et preuves de chaque tentative : début, identifiants fournisseur reçus, coût reçu, empreinte du résultat, résultat certain ou incertain. Consulter ce même registre avant exécution et après restauration. Ne pas déduire l'absence d'appel d'une simple absence d'entrée.
4. Garantir l'intégrité et la conservation indépendantes : permissions d'écriture restreintes, protection vérifiable contre altération/suppression, sauvegarde ou réplication séparée des données utilisateur ; tester coupures et restaurations du registre lui-même. Choisir le stockage après définition de ces garanties.
5. Raccorder une lecture fournisseur à la réconciliation uniquement avec identité et droits validés. Correspondance ambiguë ou preuves insuffisantes : maintien de `BLOCK`. Aucun replay implicite de l'ancienne approbation.

Ce lot doit réutiliser le gate et le contrôle `recovery/`, pas introduire deux autorités concurrentes. Aucune de ces extensions n'a été implémentée par cet audit.

Limites : pas de test de coupure électrique/perte du disque, ni de réconciliation contre l'historique réel ElevenLabs. La robustesse SaaS de ce registre reste à établir ; les runs incertains doivent rester bloqués.
