const path = require('node:path');
const addon = require(path.join(__dirname, 'napi_http_spike.node'));

const count = 120;
const callbackWorkMs = 5;
const samples = [];
const started = performance.now();
function busyWait(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
}
addon.startBackpressureProbe(count, (...rawArgs) => {
  const args = rawArgs.length === 1 && Array.isArray(rawArgs[0]) ? rawArgs[0] : rawArgs;
  const [index, rustAtMs] = args;
  busyWait(callbackWorkMs);
  samples.push({ index, rustAtMs, jsAtMs: +(performance.now() - started).toFixed(1) });
});
setTimeout(() => {
  const first = samples[0];
  const middle = samples[Math.floor(samples.length / 2)];
  const last = samples.at(-1);
  const ok = samples.length === count && last.index === count - 1 && last.rustAtMs >= 400;
  console.log(JSON.stringify({ runtime: typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`, count, callbackWorkMs, first, middle, last, ok }));
  if (!ok) process.exitCode = 1;
}, 1200);
