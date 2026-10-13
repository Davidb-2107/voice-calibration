import {test} from 'node:test';
import {strictEqual, deepStrictEqual, ok} from 'node:assert';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalStore, withFileLock} from '../dist/calibration/local-store.js';
import {initializeStandardCorpus} from '../dist/calibration/standard-corpus.js';

test('fresh workspace gets one isolated standard version; repeated or concurrent initialization is idempotent',async t=>{
  const root=mkdtempSync(join(tmpdir(),'standard-corpus-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createLocalStore(root);
  await Promise.all(Array.from({length:8},()=>initializeStandardCorpus(root,'a')));
  const a=await store.corpus.getActiveVersion('a');
  strictEqual((await store.corpus.listVersions('a')).length,1);
  strictEqual(a.items[0].id,'standard-fr-medium');ok(a.items[0].text.length>500);
  await initializeStandardCorpus(root,'b');
  const b=await store.corpus.getActiveVersion('b');
  strictEqual(b.contentDigest,a.contentDigest);ok(b.id!==a.id);strictEqual(b.workspaceId,'b');
  strictEqual((await store.runs.list('a')).length,0);
  unlinkSync(join(root,'workspaces/a/corpus/active.json'));
  await initializeStandardCorpus(root,'a');
  strictEqual(await store.corpus.getActiveVersion('a'),null);
  strictEqual((await store.corpus.listVersions('a')).length,1);
});

test('onboarding publication preserves an ordinary publication queued ahead of it under the shared lock',async t=>{
  const root=mkdtempSync(join(tmpdir(),'standard-corpus-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createLocalStore(root);
  await initializeStandardCorpus(root,'source');
  const seed=await store.corpus.getDraft('source');
  const draft=await store.corpus.saveDraft('pending',{...seed,workspaceId:'pending',revision:0},0);
  let unlock;
  const held=new Promise(resolve=>{unlock=resolve;});
  let entered;
  const locked=new Promise(resolve=>{entered=resolve;});
  const lock=withFileLock(join(root,'workspaces/pending/corpus/draft.json'),async()=>{entered();await held;},30_000);
  await locked;
  const ordinary=store.corpus.publishDraft('pending',draft.revision);
  const onboarding=store.corpus.publishDraftIfUnpublished('pending',draft.revision);
  unlock();
  const version=await ordinary;
  strictEqual(await onboarding,null);
  await lock;
  deepStrictEqual(await store.corpus.getActiveVersion('pending'),version);
  strictEqual((await store.corpus.listVersions('pending')).length,1);
  await initializeStandardCorpus(root,'pending');
  deepStrictEqual(await store.corpus.getActiveVersion('pending'),version);
});

test('conditional onboarding preserves a changed custom draft and restored version history; manual publication remains general',async t=>{
  const root=mkdtempSync(join(tmpdir(),'standard-corpus-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createLocalStore(root);
  const initial=await store.corpus.saveDraft('edited',{workspaceId:'edited',revision:0,items:[{id:'seed',order:0,text:'Original.'}]},0);
  const custom=await store.corpus.saveDraft('edited',{...initial,items:[{id:'custom',order:0,text:'Keep this custom draft.'}]},initial.revision);
  strictEqual(await store.corpus.publishDraftIfUnpublished('edited',initial.revision),null);
  deepStrictEqual(await store.corpus.getDraft('edited'),custom);
  strictEqual(await store.corpus.getActiveVersion('edited'),null);
  strictEqual((await store.corpus.listVersions('edited')).length,0);
  const first=await store.corpus.publishDraft('edited',custom.revision);
  const second=await store.corpus.publishDraft('edited',custom.revision);
  ok(first.id!==second.id);
  deepStrictEqual(await store.corpus.getActiveVersion('edited'),second);
  unlinkSync(join(root,'workspaces/edited/corpus/active.json'));
  strictEqual(await store.corpus.publishDraftIfUnpublished('edited',custom.revision),null);
  strictEqual(await store.corpus.getActiveVersion('edited'),null);
  strictEqual((await store.corpus.listVersions('edited')).length,2);
});

test('onboarding preserves custom drafts and published corpora, and resumes only its own first draft',async t=>{
  const root=mkdtempSync(join(tmpdir(),'standard-corpus-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createLocalStore(root);
  const custom=await store.corpus.saveDraft('custom',{workspaceId:'custom',revision:0,items:[{id:'private',order:0,text:'Private text.'}]},0);
  await initializeStandardCorpus(root,'custom');
  deepStrictEqual(await store.corpus.getDraft('custom'),custom);strictEqual(await store.corpus.getActiveVersion('custom'),null);
  const version=await store.corpus.publishDraft('custom',custom.revision);
  await initializeStandardCorpus(root,'custom');deepStrictEqual(await store.corpus.getActiveVersion('custom'),version);
  await initializeStandardCorpus(root,'source');
  const seed=await store.corpus.getDraft('source');
  await store.corpus.saveDraft('pending',{...seed,workspaceId:'pending',revision:0},0);
  await initializeStandardCorpus(root,'pending');
  strictEqual((await store.corpus.listVersions('pending')).length,1);
});
