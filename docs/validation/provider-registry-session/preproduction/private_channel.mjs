// Private inherited streams only. No listener, path lookup or executable selected by a peer.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';

export function engineTiming(timeoutMs = 120000) {
  // Two MCP requests (initialize + list/call), 30s Docker startup, 10s
  // independent preflight, and room for fixed corpus I/O and scheduling.
  const channelMs = 2 * Math.max(timeoutMs, 10000) + 60000;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0
      || channelMs > 2147483647) throw new RangeError('Invalid engine timeout');
  return { transportMs: timeoutMs, channelMs };
}

export function createChannel(input, output) {
  const events = new EventEmitter();
  const pending = new Map();
  let next = 0;
  let handler;
  let closed = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const send = value => {
    if (closed) throw new Error('Private channel closed');
    const line = JSON.stringify(value);
    if (line.length > 2 ** 26) throw new Error('Private frame exceeds limit');
    output.write(line + '\n');
  };
  const close = () => {
    if (closed) return;
    closed = true;
    lines.close();
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer); reject(new Error('Private channel closed'));
    }
    pending.clear(); events.emit('closed');
  };
  lines.on('close', close);
  lines.on('line', async line => {
    try {
      if (line.length > 2 ** 26) throw new Error('Private frame exceeds limit');
      const message = JSON.parse(line);
      if (!message || typeof message !== 'object') throw new Error('Malformed private frame');
      if (message.kind === 'response') {
        const entry = pending.get(message.id);
        if (!entry) throw new Error('Unexpected private response');
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), {
          emitted: message.error.emitted, code: message.error.code, stderr: message.error.stderr,
        }));
        else entry.resolve(message.result);
      } else if (message.kind === 'request' && Number.isSafeInteger(message.id) && handler) {
        try { send({ kind: 'response', id: message.id, result: await handler(message.method, message.args) }); }
        catch (error) { send({ kind: 'response', id: message.id, error: {
          message: error.message, code: error.code, emitted: error.emitted, stderr: error.stderr,
        } }); }
      } else if (message.kind === 'event' && typeof message.name === 'string') {
        events.emit(message.name, message.value);
      } else throw new Error('Unknown private frame');
    } catch (error) { events.emit('fault', error); close(); }
  });
  return {
    events, close, handle(callback) { handler = callback; },
    event(name, value) { send({ kind: 'event', name, value }); },
    request(method, args, timeoutMs = 90000) {
      if (closed || pending.size >= 64) return Promise.reject(new Error('Private channel unavailable'));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
        return Promise.reject(new RangeError('Invalid private request timeout'));
      const id = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Private request timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ kind: 'request', id, method, args }); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
  };
}

class PrivateSocket extends Duplex {
  constructor(channel, id) {
    super({ allowHalfOpen: true });
    this.channel = channel; this.id = id;
    this.remoteAddress = this.localAddress = '127.0.0.1';
    this.remotePort = this.localPort = 0;
    this.connecting = false;
  }
  _read() {}
  _write(data, encoding, callback) {
    try { this.channel.event('http.data', { id: this.id, data: data.toString('base64') }); callback(); }
    catch (error) { callback(error); }
  }
  _final(callback) { this.channel.event('http.end', { id: this.id }); callback(); }
  _destroy(error, callback) {
    try { this.channel.event('http.destroy', { id: this.id }); } catch {}
    callback(error);
  }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
}

const socketMaps = new WeakMap();
function sockets(channel) {
  if (socketMaps.has(channel)) return socketMaps.get(channel);
  const map = new Map(); socketMaps.set(channel, map);
  channel.events.on('http.data', ({ id, data }) => map.get(id)?.push(Buffer.from(data, 'base64')));
  channel.events.on('http.end', ({ id }) => map.get(id)?.push(null));
  channel.events.on('http.destroy', ({ id }) => {
    const socket = map.get(id); map.delete(id); socket?.destroy();
  });
  channel.events.on('closed', () => { for (const socket of map.values()) socket.destroy(); map.clear(); });
  return map;
}
function addSocket(channel, id) {
  const map = sockets(channel);
  if (map.size >= 64 || map.has(id)) throw new Error('Private HTTP connection limit');
  const socket = new PrivateSocket(channel, id);
  map.set(id, socket);
  socket.on('error', () => {});
  socket.once('close', () => map.delete(id));
  return socket;
}
export function attachHttpServer(server, channel) {
  sockets(channel);
  channel.events.on('http.open', ({ id }) => server.emit('connection', addSocket(channel, id)));
}
let nextSocket = 0;
export function proxyHttpRequest(req, res, channel) {
  const id = ++nextSocket;
  let socket;
  try {
    socket = addSocket(channel, id);
    channel.event('http.open', { id });
    const upstream = http.request({ method: req.method, path: req.url, headers: req.headers,
      createConnection: () => socket, agent: undefined }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  } catch {
    socket?.destroy();
    if (!res.headersSent) res.writeHead(503);
    res.end();
  }
}
