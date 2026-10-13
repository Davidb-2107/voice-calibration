import {test} from 'node:test';
import {strictEqual, deepStrictEqual, ok} from 'node:assert';
import {mkdtempSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalStore} from '../dist/calibration/local-store.js';
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
