import { join } from "node:path";
import { assertWorkspaceId } from "./domain.js";
import { assertNoSymlinkWithin, canonicalLocalPath, createLocalStore, withFileLock } from "./local-store.js";

// Existing published local-default reference texts; no voice observations or client history.
const STANDARD_ITEMS = [
  {
    id: "standard-fr-medium",
    order: 0,
    text: "Les villes ont toutes la même structure invisible. On y trouve des avenues principales, des rues secondaires, des impasses oubliées. Chaque quartier porte une mémoire qui lui est propre. Les façades changent, les enseignes disparaissent, mais la géométrie reste. Tu peux fermer les yeux dans un quartier que tu connais bien, et te souvenir exactement de la disposition des choses. Les bâtiments anciens cohabitent avec les constructions récentes sans heurt apparent. Les enfants qui jouent aujourd'hui dans une cour reproduisent sans le savoir les trajets de ceux qui les ont précédés cinquante ans plus tôt. Les passants se croisent sans se voir, perdus dans leurs propres routines. La ville se transforme sans cesse, mais elle conserve toujours quelque chose d'identique à elle-même, quelque chose que personne n'a vraiment décidé, et que personne ne pourrait expliquer.",
  },
];

export async function initializeStandardCorpus(dataDir: string, workspaceId: string): Promise<void> {
  assertWorkspaceId(workspaceId);
  const root = canonicalLocalPath(dataDir);
  const workspaceRoot = join(root, "workspaces", workspaceId);
  await assertNoSymlinkWithin(root, workspaceRoot);
  const store = createLocalStore(root);
  await withFileLock(
    join(workspaceRoot, "corpus", "onboarding"),
    async () => {
      if (await store.corpus.getActiveVersion(workspaceId)) return;
      // A missing active pointer in an existing workspace must not silently reconstruct restored history.
      if ((await store.corpus.listVersions(workspaceId)).length || (await store.runs.list(workspaceId)).length) return;
      let draft = await store.corpus.getDraft(workspaceId);
      if (draft.revision === 0 && draft.items.length === 0) {
        draft = await store.corpus.saveDraft(workspaceId, { ...draft, items: STANDARD_ITEMS }, draft.revision);
      }
      // Resume only our first standard draft; preserve every custom or subsequently edited draft.
      if (draft.revision === 1 && JSON.stringify(draft.items) === JSON.stringify(STANDARD_ITEMS)) {
        await store.corpus.publishDraftIfUnpublished(workspaceId, draft.revision);
      }
    },
    30_000,
  );
}
