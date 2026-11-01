import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createChannel, attachHttpServer, proxyHttpRequest } from './private_channel.mjs';
import * as privateChannel from './private_channel.mjs';

test('HTTP and scoped RPC traverse inherited streams, without a candidate listener', async () => {
  const forward = new PassThrough();
  const backward = new PassThrough();
  const host = createChannel(backward, forward);
  const candidate = createChannel(forward, backward);
  host.handle(async (method, args) => {
    if (method !== 'preflight' || args.workspace !== 'registered') throw new Error('Unknown scope');
    return { accepted: true };
  });
  assert.deepEqual(await candidate.request('preflight', { workspace: 'registered' }), { accepted: true });
  await assert.rejects(candidate.request('preflight', { workspace: 'other' }), /Unknown scope/);
  const application = http.createServer((req, res) => {
    assert.equal(req.socket.remoteAddress, '127.0.0.1');
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, authenticated: false }));
  });
  attachHttpServer(application, candidate);
  const frontend = http.createServer((req, res) => proxyHttpRequest(req, res, host));
  await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${frontend.address().port}/api/bootstrap`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { path: '/api/bootstrap', authenticated: false });
    assert.equal(application.listening, false);
  } finally {
    frontend.closeAllConnections();
    await new Promise(resolve => frontend.close(resolve));
    host.close(); candidate.close();
  }
});

test('HTTP connection saturation returns 503 and leaves the authority channel usable', async () => {
  const forward = new PassThrough();
  const backward = new PassThrough();
  const host = createChannel(backward, forward);
  const candidate = createChannel(forward, backward);
  candidate.handle(async method => ({ accepted: method === 'still-alive' }));
  const application = http.createServer(() => {});
  attachHttpServer(application, candidate);
  const requests = [];
  const responses = [];
  function pendingRequest() {
    const req = new PassThrough();
    Object.assign(req, { method: 'POST', url: '/hold', headers: {} });
    const res = new PassThrough();
    res.headersSent = false;
    res.writeHead = status => { res.statusCode = status; res.headersSent = true; return res; };
    res.resume();
    requests.push(req); responses.push(res);
    return { req, res };
  }
  try {
    for (let i = 0; i < 64; i++) {
      const { req, res } = pendingRequest();
      proxyHttpRequest(req, res, host);
    }
    const limited = pendingRequest();
    assert.doesNotThrow(() => proxyHttpRequest(limited.req, limited.res, host));
    assert.equal(limited.res.statusCode, 503);
    assert.equal(limited.res.writableEnded, true);
    assert.deepEqual(await host.request('still-alive'), { accepted: true });
  } finally {
    for (const req of requests) req.destroy();
    for (const res of responses) res.destroy();
    host.close(); candidate.close();
  }
});

test('engine timing preserves the requested deadline and both MCP protocol phases', () => {
  assert.equal(typeof privateChannel.engineTiming, 'function');
  for (const timeoutMs of [1, 10000, 70000, 120000, 300000]) {
    const timing = privateChannel.engineTiming(timeoutMs);
    assert.equal(timing.transportMs, timeoutMs);
    assert.equal(timing.channelMs, 2 * Math.max(timeoutMs, 10000) + 60000);
  }
  assert.equal(privateChannel.engineTiming().transportMs, 120000);
  for (const invalid of [0, -1, NaN, Infinity, '120000', 2 ** 31])
    assert.throws(() => privateChannel.engineTiming(invalid), /timeout/i);
});

test('private IPC allows preflight, startup, initialize and tool response within the caller budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forward = new PassThrough();
  const backward = new PassThrough();
  const host = createChannel(backward, forward);
  const candidate = createChannel(forward, backward);
  candidate.handle(() => new Promise(resolve => setTimeout(() => resolve({ success: true }), 278000)));
  let outcome = 'pending';
  const pending = host.request('engine', {}, 300000).then(
    value => { outcome = 'fulfilled'; return value; },
    error => { outcome = 'rejected'; return error; });
  try {
    t.mock.timers.tick(90001);
    await Promise.resolve();
    assert.equal(outcome, 'pending');
    t.mock.timers.tick(187999);
    assert.deepEqual(await pending, { success: true });
    assert.equal(outcome, 'fulfilled');
  } finally { host.close(); candidate.close(); }
});
