const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const root = __dirname;
const runtime = process.argv[2] || 'node';
const server = spawn(process.execPath, [path.join(root, 'oracle-h2.cjs')], { stdio: ['ignore', 'pipe', 'inherit'] });
const lines = readline.createInterface({ input: server.stdout });
const observed = [];
lines.on('line', (line) => { observed.push(JSON.parse(line)); console.error(line); });
function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const prior = observed.find(predicate);
    if (prior) return resolve(prior);
    const timer = setTimeout(() => reject(new Error('oracle event timeout')), timeoutMs);
    lines.on('line', (line) => {
      const item = JSON.parse(line);
      if (predicate(item)) { clearTimeout(timer); resolve(item); }
    });
  });
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}
(async () => {
  try {
    const { port } = await waitFor((item) => item.event === 'listening');
    await run(process.execPath, [path.join(root, 'control-h2-ping.cjs'), String(port)]);
    await waitFor((item) => item.event === 'ping' && item.label === 'control');
    await run(runtime, [path.join(root, 'probe-request.cjs'), 'h2', `https://127.0.0.1:${port}/hold`]);
    const rustPingCount = observed.filter((item) => item.event === 'ping' && item.label === 'rust').length;
    console.log(JSON.stringify({ runtime, positiveControlPings: observed.filter((item) => item.event === 'ping' && item.label === 'control').length, rustPingCount }));
    if (rustPingCount < 2) process.exitCode = 1;
  } finally {
    server.kill('SIGTERM');
  }
})().catch((error) => { console.error(error.stack); process.exitCode = 1; server.kill('SIGTERM'); });
