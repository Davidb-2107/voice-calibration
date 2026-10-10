# Offline engine benchmark

`benchmark.mjs`, `benchmark-worker.py` and `benchmark-profiles.py` are test-only.
They reuse the installed core and real MCP stdio process behind EngineManager.
Never use the fake worker as a production entrypoint or publish its measurements
into a production corpus.

The session harness `temp/docker_engine_benchmark.py` stages this Docker definition,
the current Node candidate and the Python candidate into a curated build context.
It replaces the validation command with the benchmark command, without modifying
the existing Dockerfile or application launch behavior. Runtime has no network,
uses fake credentials, a private named volume, 4 CPU and 4 GiB with no swap.

Default tiers: 1, 5, 10 and 20. Each tier starts engines sequentially, runs five
simulated calls per workspace concurrently, injects one mid-call SIGKILL, attempts
concurrent replacements and recreates the container against the same volume.
Each fake call allocates 32 MiB, hashes it once and sleeps 0.7 seconds. Audio
dependencies return canned durations. This is not a production audio load model.

The harness records startup timing, RSS/PSS and cgroup metrics, counts durable
fake provider receipts and checks persistent reports, profiles and observations.
Sampling is every 250 ms, so maxima are sampled. It reports `DEGRADED` for failed
concurrent restarts, retaining the application's existing timeouts. It does not
silently tune timeouts, retry uncertain synthesis or skip restoration after a
restart failure. Any other failed assertion stops the run with a nonzero exit.

See `LINUX-ENGINE-BENCHMARK.md` in the session workspace for dated results and
artifact links. Tests have no real Auth/Supabase, HTTP route load or hosted
infrastructure. Container isolation per client and its cost remain untested.

The host harness also accepts `20 --start-limits 2 3 4 5 --repeats 3`.
Each case measures three consecutive restart waves, the observed startup factory
concurrency, CPU and memory, and a startup failure with more followers than permits.
The failed worker exits before its handshake; all queued real-worker followers
must still start. Each case retains its crash and persistent-container-restoration
checks. This experiment changes neither the MCP timeout nor production audio.
# Benchmark audio hors ligne

## Démarrage à la demande

`python temp/docker_engine_benchmark.py --on-demand` construit une image isolée,
enregistre cent workspaces sans moteur, puis sollicite trois workspaces via une
API HTTP avec Auth/RLS simulés. Le transport MCP et la persistance sont réels ;
le fournisseur et l'audio sont simulés. Le test mesure premier réveil, requête
chaude et réveils après arrêt explicite, regroupe huit demandes simultanées et
compare approbations, corpus, rapports et profils. Il refuse les lectures de runs
étrangers et vérifie zéro processus Python lorsque tous les moteurs sont arrêtés.
Ce scénario ne teste ni une file durable ni un arrêt automatique après inactivité.

Pour l'arrêt automatique :
`python temp/docker_engine_benchmark.py --on-demand --idle-timeout-ms 1000`.
Le délai d'une seconde est expérimental. Le harnais attend la disparition des
PID sans appeler leur fermeture explicite, vérifie qu'une calibration reste
active au-delà du délai, puis compare les données après réveil. Les lectures
finales passent à nouveau par le résolveur car des moteurs peuvent déjà dormir.
Le défaut de dix minutes est testé avec l'horloge simulée dans les tests Node.

Depuis le dossier de session contenant les deux candidats :

```bash
python temp/docker_engine_benchmark.py --audio --repeats 3
```

Le harnais copie trois narrations Neon locales dans un contexte temporaire. Il ajoute deux pauses de 0,8 s et une fin silencieuse de 1,2 s avec FFmpeg, puis réutilise les adaptateurs audio installés en mode strict. Le fournisseur renvoie les MP3 locaux, sans attente artificielle et sans réseau. Les fichiers audio ne sont pas ajoutés au dépôt.

Les mesures distinguent 0/1/5/10/20 moteurs au repos et 1/5/10/20 calibrations concurrentes avec 20 moteurs actifs. Chaque calibration comporte cinq réponses audio. Trois répétitions utilisent trois narrations distinctes et des profils fictifs distincts, pour respecter les contrôles de recalibration. Les assertions vérifient les reçus, les observations publiées et RAW > TRIM > CUT.

`maxConcurrentStarts = 4` est propre à l'expérience. La concurrence des calibrations reste explicitement différente de celle des démarrages. Le timeout MCP de démarrage reste inchangé. Le rapport contient temps mural, CPU/throttling cgroup, PSS des moteurs et des sous-processus FFmpeg/FFprobe, ainsi que les durées audio réelles. Les échantillons de mémoire à 100 ms ne garantissent pas les pics absolus.

Ce harnais reste local à la session et connaît le chemin du vault pour récupérer les entrées. Il ne mesure ni le délai réseau/provider, ni Whisper, ni le rendu vidéo, ni les routes HTTP/Supabase. Les résultats ne représentent pas un nombre de clients SaaS sans hypothèses sur leur fréquence d'utilisation et leur latence acceptable.
