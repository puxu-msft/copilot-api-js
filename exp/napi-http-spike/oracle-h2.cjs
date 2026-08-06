const http2 = require('node:http2');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
let totalPings = 0;
let controlPings = 0;
let rustPings = 0;
const sessions = new Set();
const server = http2.createSecureServer({
  key: fs.readFileSync(path.join(root, 'certs/key.pem')),
  cert: fs.readFileSync(path.join(root, 'certs/cert.pem')),
  allowHTTP1: false,
});
server.on('session', (session) => {
  sessions.add(session);
  let label = 'unknown';
  session.on('ping', (payload) => {
    totalPings++;
    if (label === 'control') controlPings++;
    if (label === 'rust') rustPings++;
    console.log(JSON.stringify({ source: 'oracle-h2', event: 'ping', label, payload: payload.toString('hex'), totalPings, controlPings, rustPings }));
  });
  session.on('close', () => sessions.delete(session));
  session.on('error', (error) => console.log(JSON.stringify({ source: 'oracle-h2', event: 'session-error', label, message: error.message })));
  session.__setLabel = (value) => { label = value; };
});
server.on('stream', (stream, headers) => {
  const label = headers['x-probe-label'] || 'rust';
  stream.session.__setLabel(label);
  stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
  console.log(JSON.stringify({ source: 'oracle-h2', event: 'held-open', label }));
  stream.on('aborted', () => console.log(JSON.stringify({ source: 'oracle-h2', event: 'stream-aborted', label })));
  stream.on('close', () => console.log(JSON.stringify({ source: 'oracle-h2', event: 'stream-close', label, rstCode: stream.rstCode })));
});
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ source: 'oracle-h2', event: 'listening', port: server.address().port, pid: process.pid }));
});
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ source: 'oracle-h2', event: 'summary', totalPings, controlPings, rustPings }));
  for (const session of sessions) session.destroy();
  server.close(() => process.exit(0));
});
