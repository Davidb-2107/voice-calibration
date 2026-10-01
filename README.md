# voice-calibration

MVP local partagé pour calibrer les voix ElevenLabs à partir d’un corpus
standard publié et produire un profil WPM canonique réutilisable par les
projets consommateurs.

## Lancer l’interface

Prérequis : Node.js 18+, `voice-calibration-mcp` dans le `PATH`, et la clé
`ELEVENLABS_API_KEY` dans le `.env` déjà utilisé par l’environnement. La clé
reste dans le backend ; elle n’est jamais demandée au navigateur.

Le paquet vit dans son propre dépôt (`C:\Users\dbele\src\voice-calibration`,
extrait de `capcut-cli-david`). Depuis la racine du dépôt :

```bash
npm install
npm run dev
```

Cette commande compile l’interface puis démarre le serveur local et ouvre le
navigateur. Pour lancer sans ouverture automatique du navigateur, utilisez
`npm run build` puis `node dist/calibration-cli.js`.

Via l’entrée CLI officielle du moteur, l’adaptateur équivalent est :

```bash
capcut-david calibration-ui --open
```

Options utiles :

```text
--workspace-id <id>   workspace fixe de l'instance
--env-file <file>     fichier .env ElevenLabs de l'instance
--wpm-path <file>     fichier JSON WPM canonique de l'instance
--data-dir <dir>       stockage local des runs et profils
--host <host>          adresse d’écoute
--port <port>          port d’écoute (0 = port libre)
--open                 ouvrir l’interface dans le navigateur
--allow-network        autoriser explicitement un bind non local
```

Le bind est local par défaut. L’interface impose le corpus publié, le
snapshot approuvé, le dry-run, l’approbation avant l’appel facturable,
l’idempotence des runs et la protection des secrets.

Une instance locale appartient au workspace fixé à son démarrage (`local-default` par défaut).
Les appels HTTP ne peuvent pas sélectionner un autre workspace. Les IDs utilisent uniquement
les minuscules ASCII, chiffres, tirets et underscores. Les runs et artefacts sont vérifiés dans
ce contexte avant toute reprise ou opération. Les credentials ElevenLabs et le WPM canonique
peuvent être sélectionnés par instance au démarrage.

Pour un workspace nommé, les deux sources explicites sont obligatoires et aucun repli
vers la clé globale ou le WPM historique n'est effectué :

```bash
node dist/calibration-cli.js --workspace-id atelier-a \
  --env-file C:/calibration/atelier-a/.env \
  --wpm-path C:/calibration/atelier-a/voice_wpm.json \
  --state-dir C:/calibration/state --open
```

Le lanceur public accepte les mêmes options :

```js
import { startVoiceCalibrationUi } from "voice-calibration";
const ui = await startVoiceCalibrationUi({
  workspaceId: "atelier-a",
  credentials: { envFile: "C:/calibration/atelier-a/.env" },
  wpmPath: "C:/calibration/atelier-a/voice_wpm.json",
  stateDir: "C:/calibration/state",
});
```

Sans option, les données et références existantes sous `workspaces/local-default/`
restent lisibles sans migration ; la découverte historique des sources demeure active.
Le navigateur utilise le workspace de l'instance. La clé, la source WPM et le
workspace sont figés pour le processus : redémarrez pour les changer. Chaque
nouveau run conserve une empreinte de cette configuration ; après un changement
de clé ou de chemin WPM, les anciens runs et rapports restent consultables mais
leurs mutations renvoient `409 configuration_mismatch`. Un run antérieur sans
empreinte renvoie `409 configuration_identity_missing` lors d'une mutation.
Modifier seulement le contenu du fichier WPM ne change pas l'empreinte.

La racine MCP contient `workspaces/<id>/` pour le contexte et le cache, et
`gate/workspaces/<id>/runs/` pour les approbations. Sans `--state-dir`, un
workspace nommé utilise `<data-dir effectif>/mcp`. Le journal est
`<wpm-path>.runs.jsonl` ; les verrous de corpus et de journal suivent ces
fichiers. Deux workspaces qui désignent volontairement le même WPM partagent
donc cette source.

Le lanceur initialise le MCP et vérifie son workspace et sa racine avant de
servir HTTP. Les verrous OS de possession empêchent deux instances d'ouvrir
le même workspace MCP ou le même workspace UI ; ils se libèrent après arrêt
normal ou forcé. La racine MCP entre dans l'empreinte des nouveaux runs.
Si l'enfant MCP s'arrête, son interface HTTP se ferme aussi ; relancer
explicitement l'instance pour reprendre.
Le lancement historique implicite reste disponible ; fournir `--state-dir`
active aussi ce contrat pour `local-default`.

L'adaptateur Python doit prendre en charge ce contrat d'instance. Un ancien
adaptateur est refusé avant le démarrage HTTP. Pour tester une version Python
candidate avant son intégration, sélectionner son répertoire de package via
`PYTHONPATH` pour le seul processus de lancement ; aucune installation globale
n'est nécessaire.

## Architecture

```text
Navigateur
    │ HTTP same-origin + nonce
    ▼
Serveur local `http-server.ts`
    │
    ▼
`CalibrationApplication`
    ├── domaine et transitions
    ├── stockage local atomique
    ├── bridge MCP/Python
    ├── credentials backend
    ├── nom de voix ElevenLabs
    └── publication WPM canonique
```

Le paquet vit dans son propre dépôt (`C:\Users\dbele\src\voice-calibration`,
extrait de `capcut-cli-david`) ; le verbe
`capcut-david calibration-ui` du moteur est un adaptateur mince qui consomme
l’API publique du paquet (lien `file:../voice-calibration` côté CLI). La source WPM autoritative reste dans
`Shared/voice-calibration/voice_wpm.json` (vault). Les projets CapCut ou
autres consommateurs utilisent ensuite les profils publiés ; ils ne sont pas
nécessaires pour lancer cet outil.

## Documentation

- [`docs/calibration-mvp.md`](./docs/calibration-mvp.md) — parcours utilisateur,
  protocole v2, corpus, dry-run, approbation et publication ;
- [`docs/calibration-architecture.md`](./docs/calibration-architecture.md) —
  composants, stockage, bridge, secrets et invariants ;
- [`docs/elevenlabs-calibration-contract-inventory.md`](./docs/elevenlabs-calibration-contract-inventory.md) —
  contrat observé du cœur de calibration.

## Vérification

```bash
npm run build
npm run typecheck
npm test
npm run lint
```

La suite `test/calibration-*.test.mjs` vérifie le domaine, le stockage, le
bridge, l’API, le rendu UI, l’idempotence, la non-exposition des secrets et
l’identité autonome du paquet.
