const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const root = __dirname;
const runtime = process.argv[2] || process.execPath;
const server = spawn(process.execPath, [path.join(root, 'oracle-http1.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: server.stdout });
const oracle = [];
lines.on('line', (line) => { oracle.push(line); console.error(line); });

function waitForPort() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oracle listen timeout')), 3000);
    lines.on('line', (line) => {
      const item = JSON.parse(line);
      if (item.event === 'listening') {
        clearTimeout(timer);
        resolve(item.port);
      }
    });
  });
}
function run(mode, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [path.join(root, 'probe-request.cjs'), mode, url], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${runtime} ${mode} exited ${code}`)));
  });
}
(async () => {
  try {
    const port = await waitForPort();
    await run('stream', `http://127.0.0.1:${port}/stream`);
    await run('abort', `http://127.0.0.1:${port}/hold`);
  } finally {
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
