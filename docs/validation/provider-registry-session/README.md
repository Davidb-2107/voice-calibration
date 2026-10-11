# Sources et preuves de validation du registre fournisseur

Archive source du lot local validé le 2026-10-11. Le code API est dans `src/calibration/` de ce dépôt ; le moteur et ses tests sont dans `Shared/voice-calibration/` du dépôt Wiki_Claude. Les scripts et rapports ici proviennent du harness local utilisé pour les validations.

Cette archive ne constitue pas un déploiement autonome. Les scripts conservent le contrat du harness original : dossier `preproduction/` avec configuration locale non versionnée, moteur dans `work/supabase-tenant-adapter/Shared/voice-calibration`, API compilée dans `work/supabase-calibration-auth/dist`, données et contrôles indépendants fournis par cette configuration. Les rapports et leurs liens décrivent ce contexte original. Ne pas les lancer directement depuis ce dossier d'archive.

Les fichiers sont archivés par liste explicite. Aucun `config.json`, fichier de credentials, clé de signature, base SQLite, corpus, audio, volume utilisateur, dépendance compilée ou journal d'exécution n'est inclus. Aucun appel fournisseur ni déploiement n'a été effectué pour cette intégration.

Validation finale : 514 tests du moteur passent (8 ignorés, avertissement Pydantic préexistant), 23 tests de préproduction passent. Les quatre P2 sont documentés dans `preproduction/PROVIDER-REGISTRY-P2-CORRECTIONS-2026-10-11.md`.

La restauration d'un ancien export correctement signé ne prouve pas l'absence d'opérations plus récentes. Coupures matérielles, sauvegarde hors site et résistance à un moteur compromis restent hors des garanties validées.
