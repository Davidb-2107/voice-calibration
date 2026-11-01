# P0.3 - Qualification Windows du parcours API, 2026-11-01

Le candidat inactif **r6** satisfait les refus demandes dans le contexte synthetique teste.
Cette qualification ne vaut ni installation, ni validation des montages operationnels, ni autorisation financiere.
Les recus et sources executes sont conserves dans [les preuves](p03-api-isolation-win64-20261101/evidence/summary.json).

## Perimetre et versions

- Service : branche `session/p03-prestart-control-service`, parent `b1db1e3e67766139234a1b7e3d018ae7d35e6826`.
- Vault : branche `session/p03-prestart-control-vault`, parent `027f6af88f852ea5c7e2832035fbcc0142c5ac7f`.
- Arbres parents identiques aux integrations service `24ceb431049cf88fe51e11a7349db2b0d06a46c9`, vault `6f9361ce543d24bc2bbbdc42090134c579a2aa55`.
- API metier : Node Windows x64 **22.23.4**, SHA-256 `dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f`.
- Node adverse reel : **24.18.0**, version observee et refusee avant entree metier.
- Controleur et sous-processus Python : **3.12.10**, executable absolu unique, options `-I -B`.
- SDK metier gele : 0.2.0, MCP 1.29.0, requests 2.34.2, filelock 3.32.0, Pydantic 2.13.4.
- Image moteur conservee : `sha256:1ec8116a5514f619b9c0e3d7d3fd587fa7765d313a344bb96155b7a7f1da2ef9`.

Le [candidat exact](p03-api-isolation-win64-20261101/evidence/candidate.json) est
`C:/Users/dbele/Documents/Codex/2026-10-07/referenced-chatgpt-conversation-this-is-an-3/preproduction/releases/p03-api-guarded-20261101-r6`.
Son API compilee a l'empreinte `b850001a2762237716f58f3e5bd7cc4cb4d4b8286e666025379d3b0f4b67133f`.
Les empreintes du sceau du controleur, du manifeste natif et des executables figurent dans
[la verification finale](p03-api-isolation-win64-20261101/evidence/final-footprint.json).
Les entrees du build sont liees par SHA-256 aux sources locales, avant commit, sans modifier les manifestes signes pour y inscrire un SHA Git ulterieur.

## Causes et correctifs

L'ancien parcours pouvait lancer l'API hors de l'AppContainer et choisir Node via l'environnement.
La sonde d'un autre processus ne prouvait pas les droits effectifs de cette API.
Le nouveau `WindowsApiCandidate` reutilise le lanceur natif qualifie et impose l'identite binaire Node avant chaque lancement.
Le superviseur verifie et verrouille les arbres metier et autorite, puis cree l'API suspendue, verifie son jeton natif et la reprend.
Le watchdog et chaque nouvelle autorite rouvrent le meme profil persistant et refont les controles.

Le vrai gestionnaire HTTP et le code metier tournent dans l'AppContainer, Low, sans capacite reseau.
Un processus de controle distinct, avec le jeton de l'autorite, porte les ports localhost et les appels independants Python/Docker.
Ce frontal n'est pas l'API AppContainer. Ses PID et celui de l'API sont distingues dans les recus.
Les deux communiquent par les seuls flux herites. Aucun changement global d'exception loopback n'a ete fait.
L'API ne recoit ni cle de qualification, ni cle de registre, ni cle temoin financiere.
Le credential fournisseur metier, lorsque declare, conserve son ancien contrat HMAC prive; la fixture n'emploie aucun credential reel.

La validation existante des workspaces, files, montages et queues est reutilisee cote autorite sur les vrais chemins.
L'API utilise des references logiques scellees a la place des chemins prives qu'elle ne peut pas lire.
La composition privee est liee par empreinte a la composition publique.
Le transport conserve sa sous-classe lors de la recreation, et ne ferme aucun conteneur jamais demarre.

Le vault ne change que ses fixtures de test. Le refus TCP global bloquait le socketpair interne de Python sous Windows.
Une exception limitee a la fabrique standard de socketpair, sur le meme thread et vers le loopback, restaure cette communication interne.
Les appels TCP ordinaires, publics et locaux, restent refuses. L'exception ne passe pas a un autre thread.
Aucun fichier du SDK metier ni aucune dependance installee n'est modifie par ce correctif de fixture.

## Jeton reel et refus avant metier

Le [rapport natif brut](p03-api-isolation-win64-20261101/evidence/native-qualification.json) contient dix cas et quatre entrees API autorisees.
Pour chacune, la sonde ouvre **le PID metier reel**, ouvre son jeton primaire et appelle `ImpersonateLoggedOnUser` avec ce jeton.
Elle ne reconstruit pas un jeton d'apres des champs d'identite.
Les acces sont de vrais `CreateFile`, sous cette impersonation, avec lecture, ecriture, suppression, `WRITE_DAC` et `WRITE_OWNER` selon la cible.
Chaque serie compte **32 refus ACCESS_DENIED et deux temoins positifs** : lecture du code et ouverture en ecriture de l'etat permis.
Les cles privees, le code, ses dossiers et les programmes de l'autorite restent proteges.

Les quatre sondages couvrent le nominal, le redemarrage automatique apres arret du seul PID de banc verifie, une nouvelle autorite, puis le retour nominal apres contrepreuves.
Le SID AppContainer persiste; les jetons primaires sont observes sur les nouveaux processus.
La version, le chemin et l'empreinte de Node correspondent au binaire scelle, sans recherche PATH.
Node 24.18.0, le JavaScript API altere, le source MCP altere et le cache libre injecte sont refuses avec **zero nouvelle entree metier**.
Des controles positifs executent les memes octets canaris valides hors du garde pour exclure une simple erreur de syntaxe.
Tous les processus du banc sont arretes a la fin. Les profils et repertoires restent conserves.

## Politique des caches Python

Politique explicite `stdlib-zip-only-v1` : aucun `.pyc`, `.pyo` ou `__pycache__` libre dans les arbres geles.
Les fichiers Python de l'autorite et du runtime qualifie sont compiles depuis le source en memoire par un chargeur qui ne lit ni n'ecrit les caches disque.
Seul le ZIP standard de l'interpreteur peut fournir du bytecode precompile, avec son empreinte liee au sceau.
Le fichier `_pth` est confine, sans `import site` ni repli vers un checkout editable ou des packages globaux.
La contrepreuve utilise un cache `UNCHECKED_HASH` valide : `-I -B` seuls executent son payload; le chargeur source l'ignore.
La verification finale du sceau apres tous les essais confirme l'absence de cache et de modification dans les artefacts qualifies.
Les caches eventuels des copies de test mutables ne sont jamais charges par le candidat.

## Commandes et resultats

Les commandes absolues, repertoires et codes retour figurent dans les recus JSON.
Les journaux bruts sont encapsules en base64 avec taille et SHA-256 pour conserver leurs octets sans reformater les preuves.

| Controle | Resultat |
| --- | --- |
| npm ci dans le build jetable, Node 22.23.4, sans scripts d'installation, audit ni financement | PASS |
| npm run build complet, TypeScript puis build UI | PASS |
| tsc --noEmit; Biome ci --formatter-enabled=false | PASS |
| npm test complet avec SDK[test] declare, venv 3.12.10 neuf | 347 PASS, 0 FAIL, 1 SKIP |
| Journal financier, test_financial_*.py, venv neuf Pydantic 2.14.2 | 85 PASS |
| Meme suite financiere, copie jetable des dependances gelees Pydantic 2.13.4 | 85 PASS |
| Tests operateur selectionnes, y compris ordre financier et guards API/cache | 50 PASS, 3 SKIP, 20 sous-tests PASS |
| Flux HTTP prive, quota et delais simules | 4 PASS |
| Creation initiale puis recreation autorisee du transport | 2 PASS, inclus dans npm test |
| Garde reseau de fixture Windows, refus TCP public/local et autre thread | 8 PASS |
| Qualification native r6 | 10 cas PASS; 4 series de sondes sous jeton API reel |
| Douze artefacts historiques et manifeste original | PASS, 543732998 octets conserves |

Le venv neuf a `include-system-site-packages = false`; pip check reussit.
Il installe les deux projets editables dans un clone jetable et l'extra test declare `pytest==9.1.1`.
Il ne reutilise ni les packages du MCP installe, ni un node_modules existant.
Le runtime de test des dependances gelees est une copie mutable distincte; seuls les outils de test absents y sont ajoutes sans changer les dependances metier.
Le candidat r6 et les douze archives historiques ne recoivent aucune installation.

Les trois SKIP Python sont les tests historiques de `service.mjs` utilisant un faux executable shell Docker POSIX :
`test_service_wrapper_supplies_required_controller_to_the_api`,
`test_service_wrapper_refuses_changed_code_before_candidate_import`,
`test_service_wrapper_rechecks_after_docker_inspection_before_import`.
Ils ne constituent pas une preuve Windows. Le nouveau parcours natif Windows a ses propres refus executes.
Le SKIP Node est `calibration-reusable-docker` : absence volontaire de `VOICE_CALIBRATION_TEST_ENGINE_IMAGE` pour ce test Docker optionnel.
Il reste NON TESTE sur cette tete. Aucun test ni garde metier n'a ete supprime pour obtenir du vert.

Les premiers essais ont revele un build UI incomplet apres `tsc` seul, puis l'absence de pytest dans un runtime de production utilise a tort comme environnement de tests.
Le build complet et le venv neuf corrigent le banc. Les echecs et profils r1 a r5 restent conserves; seuls r5 puis r6 utilisent le build UI complet.
R5 est depasse par r6 pour les programmes de controle.

## Revue et decisions

Une revue independante Standards et Spec a releve zero critique, deux importants et un mineur.
Les deux importants ont d'abord ete reproduits en rouge, puis corriges en une passe.

1. Saturation HTTP : la 65e connexion levait une exception non interceptee. Elle recoit desormais 503 avant emission `http.open`; une creation avortee nettoie sa socket. Le canal reste utilisable.
2. Delais : le controleur plafonnait a 60 secondes et l'IPC a 90 secondes, contre 120 secondes dans le contrat existant. Le delai moteur demande est conserve. L'IPC couvre deux phases MCP, le demarrage Docker et le precontrole, avec une marge bornee. Une horloge simulee couvre 278 secondes sans attente ni emission fournisseur.
3. Le test de reprise ne faisait qu'un bootstrap. Il en execute maintenant deux apres fermeture sur echec, et prouve la deuxieme creation polymorphe.

Les tests d'ordre financier utilisent des doubles explicites du garde natif et du pin Node pour isoler leur garantie d'ordre; ils conservent le vrai lecteur financier et ses controles de configuration.
La qualification native utilise les vrais gardes, executables, ACL et jetons. Ces deux niveaux de preuve sont distincts.
L'executeur a verifie les corrections et rejoue r6; aucune seconde revue n'est annoncee.

## Conservation et limites avant intervention installee

Le [recu de conservation](p03-api-isolation-win64-20261101/evidence/installed-preservation.json) compare les metadonnees installees avant et apres.
Le runtime API installe reste `b105d9869fa9d87bb63061202bf3c85a36730bd65ef6cf77be3b9a4414c0074f`.
La configuration du service, ses scripts actifs, sa tache watchdog, les metadonnees des droits, cles, registres et fichiers operationnels sont identiques dans la comparaison.
Aucune cle reelle n'a ete lue en octets, aucune SQLite operationnelle ouverte, aucune requete API operationnelle executee par l'inventaire.
Les modifications locales preexistantes du vault canonique restent presentes et son index est vide.
Deux differences hors perimetre ont ete observees et conservees : un nouveau fichier non suivi `wiki/concepts/codegraph.md` dans le vault canonique et une nouvelle empreinte du fichier global Codex.
Les entrees MCP voix selectionnees dans cette configuration restent identiques. Leur origine n'est pas attribuee a ce travail et aucun retour arriere n'a ete applique sur ces changements externes.

Restent distinctement NON TESTES : la commande effective du PID installe, les montages d'un moteur actif, la reconnexion Windows reelle et le contexte de donnees operationnelles.
Une nouvelle autorite de processus n'est pas presentee comme une reconnexion de session Windows.
La fixture financiere est synthetique, avec un workspace de banc et ses propres cles. Elle ne doit pas etre activee comme configuration operationnelle.
Le lot historique service24ceb431/vault6f9361ce est conserve comme reference, mais ses anciens programmes API ne sont pas le correctif qualifie ici.
La prochaine composition operationnelle devra lier le commit correctif et ces empreintes, garder les registres comme source de verite, puis passer les controles sur la vraie composition autorisee.

Aucune sauvegarde operationnelle, installation, bascule, modification des appartenances ou droits existants, activation financiere, emission fournisseur, publication Git ou suppression de profil/worktree n'a eu lieu.
La sauvegarde verifiee reste a effectuer juste avant toute intervention installee autorisee. La bascule exige un accord distinct.
Les commits locaux se lisent dans Git sur les deux branches; aucune CI distante de ces nouveaux commits n'est revendiquee avant un push autorise.
