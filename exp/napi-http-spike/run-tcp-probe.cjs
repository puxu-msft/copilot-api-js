const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const root = __dirname;
const runtime = process.argv[2] || 'node';
const server = spawn(process.execPath, [path.join(root, 'oracle-http1.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const serverLines = readline.createInterface({ input: server.stdout });
serverLines.on('line', (line) => console.error(line));
let port;
serverLines.on('line', (line) => {
  const item = JSON.parse(line);
  if (item.event === 'listening') {
    port = item.port;
    const client = spawn(runtime, [path.join(root, 'probe-request.cjs'), 'tcp', `http://127.0.0.1:${port}/hold`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const clientLines = readline.createInterface({ input: client.stdout });
    clientLines.on('line', (clientLine) => {
      process.stdout.write(`${clientLine}\n`);
      const event = JSON.parse(clientLine);
      if (event.event === 'tcp-probe-started') {
        setTimeout(() => {
          const ss = spawn('ss', ['-tno', 'state', 'established']);
          let output = '';
          ss.stdout.on('data', (chunk) => { output += chunk; });
          ss.on('exit', (code) => {
            const matching = output.split('\n').filter((line) => line.includes(`:${port}`));
            const keepalive = matching.filter((line) => line.includes('timer:(keepalive'));
            console.log(JSON.stringify({ event: 'ss-snapshot', code, port, matching, keepalive, ok: keepalive.length > 0 }));
            if (keepalive.length === 0) process.exitCode = 1;
          });
        }, 1800);
      }
    });
    client.on('exit', (code) => {
      if (code !== 0) process.exitCode = 1;
      server.kill('SIGTERM');
    });
  }
});
setTimeout(() => {
  if (!port) {
    console.error('oracle listen timeout');
    process.exitCode = 1;
    server.kill('SIGTERM');
  }
}, 3000);
