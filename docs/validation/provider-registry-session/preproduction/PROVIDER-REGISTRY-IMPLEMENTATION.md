# Registre indépendant des opérations fournisseur — 2026-10-11

## Résultat

Le registre de récupération existant a été étendu. La préproduction locale utilise désormais un journal fournisseur SQLite par workspace, indépendant des données utilisateur et de leurs sauvegardes. Les anciennes quarantaines sont conservées. Aucun appel authentifié ElevenLabs, aucune synthèse réelle, aucun commit ni push n'a été effectué.

Les validations de développement de la version finale donnent **490 tests Python PASS**, **260 tests Node PASS** et **18 tests de préproduction PASS**. Neuf tests sont ignorés au total ; un avertissement Pydantic préexistant subsiste. Le scénario Docker final passe avec quatre appels simulés et aucun replay des approbations restaurées.

## Ce qui a changé

### Avant chaque exécution

Le gate valide toujours l'approbation, son expiration et son identité de configuration, puis consomme l'approbation dans le run. Il réserve ensuite ce run dans le journal indépendant, avant d'appeler le moteur. Une réservation existante refuse le replay, même si la sauvegarde utilisateur restaure un run `approved` avec `consumed_at=null` et si le guard est `ready`.

Avant chaque synthèse de la calibration, une tentative est réservée dans une transaction SQLite `synchronous=FULL`. Son identifiant déterministe associe scope tenant/workspace, run et élément du plan. Les clés uniques empêchent deux réservations concurrentes de la même opération.

Chaque tentative conserve : tenant/workspace, run, approbation consommée, digest approuvé, identité HMAC de la configuration/credentials, voix, modèle, réglages effectifs, langue, post-traitement, empreinte du texte, horodatages et événements. Aucun credential fournisseur brut n'est enregistré dans le journal.

### États et preuves

- Une réservation commence en `execution_unknown` : son existence ne prouve ni transmission ni facturation.
- Les identifiants et coûts reçus dans les headers sont conservés **avant** la lecture du corps audio. Une perte ultérieure du corps ne détruit pas ces identifiants.
- Un audio reçu ajoute `received`, son SHA256 et les headers utiles, avant cache, traitement audio ou publication. Un échec local conserve donc la preuve fournisseur et reste distinct de l'état de traitement du run.
- Une erreur pendant l'invocation devient `execution_unknown`, jamais une preuve d'absence de dépense. Le CLI s'arrête avec un message de réconciliation ; le gate bloque le replay.
- Le POST payant ne suit plus les redirections. Aucun retry automatique fournisseur n'a été ajouté.
- Une réponse fournisseur dont l'écriture de preuve échoue reste bloquée. Les mises à jour de preuve utilisent une comparaison transactionnelle de la version précédente ; elles n'écrasent pas une modification concurrente.

### Intégrité et isolation

Le journal et son contrôle sont mis à jour dans la même transaction SQLite. Le contrôle authentifie par HMAC le scope et l'ensemble des documents ; modification de document, suppression de lignes, contrôle manquant, clé différente ou scope étranger provoquent un blocage. Un journal absent n'est jamais recréé lors de la lecture ou de l'exécution. L'installateur refuse aussi de recréer un journal précédemment initialisé qui a disparu.

Dans Docker, le contrôle de restauration et la clé de signature restent montés en lecture seule ; seul le sous-répertoire du journal du workspace est writable. L'API refuse les chemins de contrôle partagés, imbriqués, recouvrant les ressources d'un autre workspace ou la file. Les liens symboliques/jonctions sont refusés par le lecteur du journal.

La signature protège contre altération/corruption sans accès à la clé. Le moteur de confiance peut lire sa propre clé pour produire les preuves : ce dispositif ne résiste pas à un moteur compromis qui signe de faux documents, ni à un administrateur restaurant ensemble une ancienne base et un contrôle valide. Les autres workspaces n'ont pas accès à ce montage.

### Restauration et réconciliation

`restore.py` ne restaure jamais le journal fournisseur avec les données utilisateur. Il en exporte une copie SQLite cohérente et vérifiée, avec empreinte SHA256, dans le contrôle indépendant, puis conserve la quarantaine. Ces exports sont des preuves ; ils ne remplacent pas automatiquement l'autorité active.

`reconcile.py` consulte désormais les réservations et tentatives signées en plus des anciennes archives. Une réservation sans réponse certaine reste bloquée. Une réponse conservée est identifiée comme non rejouable. Aucune décision n'autorise une nouvelle synthèse ni ne retire un guard.

Le module `core/provider_history.py` raccorde une **lecture explicite** de l'historique ElevenLabs au registre. Il valide le workspace et l'identité des credentials avant toute lecture ; il exige un `history_item_id` ou `request_id` déjà reçu. Il utilise uniquement des GET, avec pagination bornée si nécessaire. Une correspondance doit confirmer identifiants, voix, modèle, paramètres et empreinte du texte. La preuve est conservée sous `reconciled_received`, sans autoriser de replay. Une absence, un historique incomplet ou une correspondance ambiguë ne débloque rien.

Ce lecteur n'est appelé ni au démarrage, ni pendant l'exécution, ni par la reprise automatique. Il a été testé uniquement avec un lecteur simulé. Il ne prétend pas retrouver avec certitude une génération quand aucun identifiant fournisseur n'a été reçu.

## Instance persistante

Lors de la vérification finale : API disponible sur `127.0.0.1:4317`, santé sur `127.0.0.1:4318`, Supabase réel accessible, propriétaire de file actif, deux registres valides, `execution: restore_quarantine`. La santé vérifie maintenant l'intégrité des journaux.

L'image effectivement testée et utilisée est `sha256:70b33e08a84ea88b0827bdb4e25e34e181812a9db0a65940c802e352f973cfe3`, label `voice-calibration.local-patch=provider-registry`. `config.json` reste la source de configuration courante. Le lot est local et non commité, ajouté aux commits de référence ; il ne constitue pas une nouvelle version intégrée de `main`.

Emplacements par workspace :

```text
recovery/<workspace>/guard.json                  contrôle, lecture seule dans Docker
recovery/<workspace>/provider-registry.key       secret de signature, lecture seule dans Docker
recovery/<workspace>/provider-registry/          journal indépendant writable
data/<workspace>/...                            données utilisateur restaurables
```

Les clés de signature doivent être exclues des commits et sauvegardées séparément de façon sécurisée. L'exécutable Python utilisé pour la santé est déclaré dans `config.json` (`registryPython`). Le lecteur déployé est copié dans `application/`, sans import depuis le worktree en exploitation.

Les six runs historiques gardent `insufficient_independent_proof_keep_blocked` : la création du journal ne fournit pas rétroactivement leurs preuves manquantes. Le fournisseur de la préproduction persistante reste exclusivement simulé.

## Vérifications et preuves

| Validation finale | Résultat | Preuve |
| --- | --- | --- |
| Package Python, suite complète | 490 PASS, 8 skipped, 1 warning | `work/supabase-tenant-adapter/.scratch/provider-registry-final-python-tests.log` |
| API Node, suite complète | 260 PASS, 1 skipped | `work/supabase-calibration-auth/.scratch/provider-registry-final-node-tests.log` |
| Restauration, réconciliation, installateur et santé | 18 PASS | `test_restore.py`, `test_reconcile.py`, `test_provider_registry_integration.py` |
| Docker Linux, deux workspaces neufs | PASS, 4 invocations simulées, 0 replay | `provider-registry-docker-report.json` |
| Réconciliation des six runs historiques | BLOCK conservé, aucun appel fournisseur | `recovery/reconciliation-report.json` |
| Compilation Node et diffs des deux worktrees | PASS | `npm run build`, `git diff --check` |

Interpréteur des tests de développement : `C:/Users/dbele/.codex/venvs/wiki-claude/Scripts/python.exe`. Ce sont des validations de catégorie A, pas une nouvelle preuve d'installation vierge. Les probes Docker utilisent `/opt/venv/bin/python` dans l'image déployée.

Les tests couvrent notamment : huit réservations concurrentes d'un run, scope étranger, altération/suppression des preuves, journal disparu, crash avant commit, après réservation, après appel avec réponse perdue et après reçu durable ; restauration d'une approbation après succès, timeout et échec audio ; lecture d'historique sans identifiant ou après changement de credentials ; conservation anticipée des headers ; absence de suivi de redirection payante ; montage de clé en lecture seule.

Le scénario Docker crée deux workspaces de validation indépendants : A est interrompu brutalement après une invocation simulée sans réponse ; B reçoit trois réponses. Deux nouveaux conteneurs reprennent/restaurent leurs approbations. Les preuves gardent respectivement une tentative incertaine et trois réponses, sans nouvelle invocation. Il ne s'agit pas d'un nouveau test de connexion de deux comptes Supabase : le raccordement Supabase précédent est conservé, et son accessibilité a été revérifiée par la santé.

Incidents résolus pendant la validation : fermeture explicite des connexions SQLite sous Windows ; fixtures CLI ne chargeant plus le runtime audio réel quand le runner est simulé ; import du lecteur de journal depuis l'application déployée ; construction Docker depuis un tag local dont l'identifiant est vérifié. Le premier run large exposait 15 échecs de fixtures CLI ; la suite finale ci-dessus ne les reproduit plus.

## Limites d'exploitation

Les quatre P2 de la revue ont ensuite été traités dans les sources : verrou d'installation, normalisation des chemins, réconciliation MCP explicite et validation de restauration des preuves. Le lot corrigé donne 514 tests Python PASS et 23 tests de préproduction PASS ; voir `PROVIDER-REGISTRY-P2-CORRECTIONS-2026-10-11.md`. Il n'a pas encore été déployé dans l'image persistante, dont les mesures précédentes restent celles du lot initial.

La restauration des preuves dans un stockage neuf est désormais testée hors ligne avec export signé et clé sauvegardée séparément : les tentatives reçues ou incertaines restent bloquées après restauration d'une ancienne approbation, sans nouvelle synthèse ni observation dupliquée. Une clé absente/différente, une base absente/incomplète/altérée ou un scope étranger bloque. La perte électrique complète, la perte du disque et la réplication hors poste n'ont pas été validées. Les copies créées sont encore locales : elles ne constituent pas une sauvegarde hors site. Ne jamais remplacer le journal actif par un export ancien pour remettre un run en marche ; un ancien export correctement signé ne prouve pas l'absence d'opérations plus récentes.

La vérification intégrale des documents est linéaire en taille du journal ; sa capacité à long terme n'a pas été benchmarkée. Les garanties concernent les moteurs configurés avec le contrôle indépendant ; les consommateurs historiques sans ce contrôle restent compatibles et n'acquièrent pas automatiquement ces garanties.

Le lecteur d'historique réel reste à valider avec une autorisation de lecture et les droits fournisseur adaptés. Sans preuve suffisante, la règle reste **BLOCK**, même si cela exige une intervention de réconciliation. Aucun remboursement, coût nul ou absence de génération n'est déduit d'un timeout.
