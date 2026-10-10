# Moteur isolé par workspace

Le transport `DockerMcpStdioTransport` conserve MCP stdio et le contrat métier. Il lance un conteneur Linux par moteur, à la demande, avec une seule racine privée montée sur `/workspace`. Le Docker daemon reste côté opérateur ; son socket n'est jamais monté dans le moteur.

Configuration minimale côté serveur :

```typescript
import { DockerMcpStdioTransport, startSupabaseCalibrationApi } from "voice-calibration";

const mcpTransport = new DockerMcpStdioTransport({
  image: imageId, // ID local immuable sha256:..., image préconstruite ; aucun pull automatique.
  root: privateRoot,
  tenantId, workspaceId,
  wpmPath, stateDir,
  uiWorkspaceDir: join(dataDir, "workspaces", workspaceId),
});
await startSupabaseCalibrationApi({ supabase, workspaces: [{
  tenantId, workspaceId, wpmPath, stateDir, dataDir,
  credentials, mcpTransport,
}] });
```

Tous les chemins de cette entrée doivent être sous `privateRoot`, dans un répertoire propre à ce workspace. La configuration est fournie par le serveur ; le client ne choisit aucun chemin, image ou credentials. Les chemins internes du moteur sont distincts des chemins hôte de l'API, et l'identité MCP reste vérifiée.

Le transport fixe : utilisateur 10001, rootfs en lecture seule, capabilities supprimées, no-new-privileges, tmpfs privé de 64 MiB, mémoire 512 MiB, 1 CPU, 64 PID. Ces limites sont des valeurs de validation, pas une capacité commerciale mesurée. Chaque conteneur est supprimé à sa fermeture ; les données sous la racine montée persistent.

**Réseau désactivé (`--network=none`)** : ce mode exécute les contrôles gratuits et bloque les appels fournisseur. Il ne peut pas synthétiser réellement. L'ouverture des sorties ElevenLabs devra être une étape distincte avec une politique d'egress et les autorisations de dépense ; ne pas remplacer ce réglage par le réseau hôte.

L'API Supabase refuse désormais par défaut les transports non isolés avant tout accès aux credentials ou démarrage de moteur, y compris sur loopback. Seule l'option explicite `allowUnisolatedLocal: true` autorise les fixtures de développement sur loopback, sans `publicOrigin`. Cette exception ne constitue pas une isolation système ; elle est refusée pour une configuration publique. Les anciens helpers payants locaux ne sont pas activés avec cette exception.

Build validé par le helper `temp/build_isolated_engine.py` de la session : contexte limité aux packages Shared déclarés, sans corpus ni `.env`. Le Dockerfile fixe l'image de base par digest et les contraintes Python ; les paquets apt ne sont pas snapshot-lockés. Le test `node test/docker-isolation-validation.mjs` démarre deux vrais moteurs, teste leurs frontières et provoque un crash, sans dépense. L'authentification est simulée dans ce test Docker ; les validations Supabase hébergées antérieures ne sont pas une validation de ce nouveau transport.
