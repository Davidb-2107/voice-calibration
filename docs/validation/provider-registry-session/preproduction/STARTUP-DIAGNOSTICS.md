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
