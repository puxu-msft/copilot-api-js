const path = require('node:path');
const addon = require(path.join(__dirname, 'napi_http_spike.node'));

const [mode, url] = process.argv.slice(2);
if (!mode || !url) throw new Error('usage: probe-request.cjs <stream|abort|h2|tcp> <url>');

const events = [];
const tickGaps = [];
let lastTick = performance.now();
const ticker = setInterval(() => {
  const now = performance.now();
  tickGaps.push(now - lastTick);
  lastTick = now;
}, 10);
const started = performance.now();
let resolveDone;
const done = new Promise((resolve) => { resolveDone = resolve; });
const requestId = addon.startRequest(
  { url, http2: mode === 'h2', tcpKeepaliveMs: mode === 'tcp' ? 1000 : undefined },
  (...rawArgs) => {
    const args = rawArgs.length === 1 && Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
    const [data, sequence, rustAtMs] = args;
    events.push({ data, sequence, rustAtMs, jsAtMs: +(performance.now() - started).toFixed(1) });
  },
  (...rawArgs) => {
    const args = rawArgs.length === 1 && Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
    resolveDone({ outcome: args[0], rustAtMs: args[1], jsAtMs: +(performance.now() - started).toFixed(1) });
  },
);

let abortIssuedAtMs;
if (mode === 'abort') {
  setTimeout(() => {
    abortIssuedAtMs = performance.now() - started;
    const accepted = addon.cancelRequest(requestId);
    events.push({ control: 'cancel', accepted, jsAtMs: +abortIssuedAtMs.toFixed(1) });
  }, 350);
}

if (mode === 'tcp') {
  console.log(JSON.stringify({ event: 'tcp-probe-started', pid: process.pid, requestId }));
}

const timeoutMs = mode === 'h2' || mode === 'tcp' ? 5500 : 5000;
Promise.race([
  done,
  new Promise((resolve) => setTimeout(() => resolve({ outcome: 'probe-timeout', jsAtMs: timeoutMs }), timeoutMs)),
]).then(async (result) => {
  let observationTimedOut = false;
  if (result.outcome === 'probe-timeout') {
    observationTimedOut = true;
    const cancelStarted = performance.now();
    addon.cancelRequest(requestId);
    result = await Promise.race([
      done,
      new Promise((resolve) => setTimeout(() => resolve({ outcome: 'cancel-settle-timeout', jsAtMs: +(performance.now() - started).toFixed(1) }), 2000)),
    ]);
    result.cancelSettleMs = +(performance.now() - cancelStarted).toFixed(1);
  }
  clearInterval(ticker);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const summary = {
    observationTimedOut,
    runtime: typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`,
    mode,
    requestId,
    result,
    abortToDoneMs: abortIssuedAtMs == null ? null : +(result.jsAtMs - abortIssuedAtMs).toFixed(1),
    activeTasks: addon.activeTaskCount(),
    registered: addon.requestIsRegistered(requestId),
    maxTickGapMs: tickGaps.length ? +Math.max(...tickGaps).toFixed(1) : null,
    events,
  };
  console.log(JSON.stringify(summary));
  const chunks = events.filter((event) => typeof event.sequence === 'number' && event.sequence > 0 && event.sequence < 200);
  const streamOk = mode !== 'stream' || (result.outcome === 'completed:3' && chunks.length === 3 && chunks[1].jsAtMs - chunks[0].jsAtMs > 150 && chunks[2].jsAtMs - chunks[1].jsAtMs > 150);
  const abortOk = mode !== 'abort' || (result.outcome === 'cancelled' && summary.activeTasks === 0 && summary.registered === false && summary.abortToDoneMs < 100);
  if (!streamOk || !abortOk || result.outcome === 'cancel-settle-timeout' || (observationTimedOut && mode !== 'h2' && mode !== 'tcp')) process.exitCode = 1;
});
