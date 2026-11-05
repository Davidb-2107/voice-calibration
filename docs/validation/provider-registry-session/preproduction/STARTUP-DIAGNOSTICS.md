# Diagnostic isolé du démarrage Windows, 4 novembre 2026

Base intégrée : `b394fbe46d183020667c6bd97f411664d9f49e15`.
Ce correctif ne qualifie pas une installation et ne change aucun garde.

`WindowsCandidate.start()` écrit sur le stderr de l'autorité des lignes JSON
`windows-candidate-startup-v1`. Phases : autorité, manifeste signé et commande,
empreintes/protections du code, lancement natif, libération des verrous de code.
Le lancement distingue les pipes, attributs, Job Object, `CreateProcessW`,
`AssignProcessToJobObject`, jeton effectif, flux, `ResumeThread` et nettoyage.
Chaque phase émet `begin`, puis `passed` ou `refused`. L'événement `created`
ajoute le PID du fils encore suspendu. Il ne prouve ni reprise ni entrée métier.

Champs fermés : schéma, temps en nanosecondes, PID de l'autorité, phase,
événement, PID du candidat si créé, chaîne des types d'exception et `winerror`
entier éventuel, indicateur de chaîne tronquée. La chaîne suit la cause explicite,
sinon le contexte non masqué, sur huit exceptions au maximum avec détection de cycle.
Aucun message d'exception, traceback, chemin, argument ou environnement n'est émis
par ce diagnostic. Les exceptions et leurs causes restent levées normalement.
Un stderr fermé ne change pas l'admission ou la propriété du processus.

Dans une future fenêtre autorisée, conserver le stderr complet du superviseur API
avant le premier essai, chercher le premier `refused` par PID et ordre `time_ns`,
puis lire les causes du refus `start`. Ne pas déduire un succès d'une absence de
trace. Si le sink est absent, cette preuve est NON TESTÉE et la fenêtre s'arrête.
Le refus historique générique reste non attribuable à une API Windows précise.
Ce correctif permettra de diagnostiquer un prochain refus, sans expliquer
rétroactivement une information qui n'a pas été conservée.

## Validation locale

Python existant de développement : 3.12.10 x64, pytest 9.1.1. Aucun paquet installé.
Ce contrôle de développement n'est pas une preuve d'installation autonome.
Node utilisé seulement dans de nouveaux répertoires de banc : 22.23.4,
SHA256 `dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f`.
Les profils AppContainer de test et les répertoires créés restent conservés.

Depuis la racine du service, avec `P03_WINDOWS_NODE` pointant sur cette image
approuvée et `P03_WINDOWS_FIXTURE_ROOT` sur une nouvelle racine jetable :

```bash
"$VC_TOOL" -I -B -m pytest -p no:cacheprovider -q \
  docs/validation/provider-registry-session/preproduction/test_startup_trace.py \
  docs/validation/provider-registry-session/preproduction/test_windows_candidate.py \
  docs/validation/provider-registry-session/preproduction/test_watchdog.py \
  docs/validation/provider-registry-session/preproduction/test_boot_watchdog.py
```

Contrepreuves : quatre échecs RED avant correction. Le refus simulé de
`CreateProcessW` rapporte son type et `winerror=5`. Le refus simulé de
`AssignProcessToJobObject` rapporte la même erreur, après création réelle d'un
fils suspendu, dont la mort est vérifiée. Dans les deux cas : zéro lancement
accepté et aucun témoin métier écrit. Les secrets témoins et causes cycliques
sont couverts. Le stderr fermé conserve la décision originale.

Résultat final : **34 PASS, 0 ÉCHEC, 0 SKIP** sous Windows, en22,82secondes.
Les deux contrepreuves AppContainer de ce nouveau fichier seraient SKIP sur
Linux ; les preuves Windows ne sont pas remplacées par ce résultat Linux.
Le journal local est `temp/p03-startup-final-20261104.log` dans le workspace
de préparation ; les fixtures sont dans `temp/p03-startup-final-20261104`.
L'installation,
ses fichiers et droits n'ont pas été modifiés. NO-GO maintenu jusqu'à une nouvelle
qualification opérationnelle autorisée.

## Correctif du contexte S4U du 5 novembre 2026

Le refus `CreateProcessW / WinError 2` a été reproduit en session Windows 0
par la même sonde Node qui passe en session interactive. Les chemins de profil,
la version Node et les empreintes du programme sont identiques.
La simple dérivation du SID ne garantit pas l'enregistrement du profil dans le
contexte S4U. L'appel `CreateAppContainerProfile` y a renvoyé `S_OK` pour le nom
déjà qualifié en session interactive. Cet enregistrement fait passer la création
native, puis Node échoue avec `0xC0000142` sur la station non interactive.
Une station et un bureau privés font alors passer la lecture de version.

Le lanceur enregistre désormais le profil dans son contexte effectif et vérifie
le SID obtenu avant de créer un processus. En session 0, il crée des objets USER
neufs, réservés à l'autorité et à cet AppContainer. Le bureau est explicite dans
`STARTUPINFO`. Les droits des stations et bureaux existants sont préservés.
La sélection temporaire de station est sérialisée et la station de l'autorité
est restaurée avant la création du fils. Les objets privés restent ouverts
jusqu'à la sortie du processus et de son Job Object, ou sont fermés au refus.

Le code partagé corrigé a passé deux lancements S4U distincts avec Node 22.23.4,
AppContainer d'intégrité basse et zéro capacité. Deux autres essais S4U ont
confirmé les refus simulés de création native et d'affectation au Job Object,
sans entrée dans le programme et sans enfant vivant après refus.
Les tests ciblés sont dans `test_windows_launch_context.py`.

Ces preuves portent sur une sonde de version isolée. Le démarrage de l'API et du
MCP installés, leur composition et leur reconnexion restent à qualifier dans une
fenêtre distincte autorisée. Le refus historique du 4 novembre au matin demeure
indéterminé. Les observations instrumentées du soir et la reproduction S4U
étayent ce correctif.

### Fermeture USER refusée

La revue du premier portage a identifié un P2 dans le nettoyage. Une exception
de fermeture USER pouvait sauter la libération des verrous de code, pipes,
attributs et SID. Le nettoyage natif utilise maintenant un ExitStack enregistré
avant les appels pouvant lever. Les verrous de code sont libérés dans un finally.
Une erreur tardive ferme aussi les flux et le handle du processus, dès lors que
sa sortie est confirmée. Un timeout conserve la propriété des ressources.

Les tests ciblés passent à onze cas, les tests de trace à six. Les autres
contrepreuves Windows, Node et MCP donnent respectivement dix-huit, deux et douze
PASS. Les quatre derniers essais S4U qualifient les octets de cette correction,
avec démarrage normal, refus de création, refus Job Object et erreur de fermeture
USER rapportée après fermeture réelle du handle. Cette dernière contrepreuve
confirme aussi la réouverture en écriture du code, sans écriture d'octets.
Les quatorze essais autorisés sont terminés et la tâche reste désactivée.
