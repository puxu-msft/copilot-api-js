const path = require('node:path');
const addon = require(path.join(__dirname, 'napi_http_spike.node'));

const received = [];
const started = performance.now();
addon.startTsfnProbe(5, 40, (...args) => {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  received.push({ value, rawArgs: args, atMs: +(performance.now() - started).toFixed(1) });
});

setTimeout(() => {
  const ok = received.length === 5 && received.every((item, i) => item.value === i);
  console.log(JSON.stringify({ runtime: `${process.release.name} ${process.version}`, received, ok }));
  if (!ok) process.exitCode = 1;
}, 350);
