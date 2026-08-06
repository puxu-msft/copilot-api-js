const http = require('node:http');

const sockets = new Set();
const server = http.createServer((req, res) => {
  const started = performance.now();
  const log = (event, extra = {}) => console.log(JSON.stringify({ source: 'oracle-h1', event, atMs: +(performance.now() - started).toFixed(1), ...extra }));
  req.on('aborted', () => log('request-aborted'));
  req.on('close', () => log('request-close', { complete: req.complete }));
  res.on('close', () => log('response-close', { writableEnded: res.writableEnded }));

  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'].forEach((chunk, index) => {
      setTimeout(() => {
        res.write(chunk);
        log('write', { index: index + 1, bytes: Buffer.byteLength(chunk) });
        if (index === 2) setTimeout(() => res.end(), 100);
      }, 150 + index * 250);
    });
    return;
  }

  if (req.url === '/hold') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    log('held-open');
    return;
  }

  res.writeHead(404).end();
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ source: 'oracle-h1', event: 'listening', port: server.address().port, pid: process.pid }));
});
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
