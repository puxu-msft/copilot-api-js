const http2 = require('node:http2');
const port = Number(process.argv[2]);
const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
session.on('error', (error) => { console.error(error.stack); process.exitCode = 1; });
const request = session.request({ ':path': '/hold', 'x-probe-label': 'control' });
request.on('response', () => {
  const payload = Buffer.from('CONTROL!');
  session.ping(payload, (error, duration, returned) => {
    console.log(JSON.stringify({ source: 'control-client', event: 'ping-ack', error: error?.message ?? null, duration, payload: returned?.toString('hex') }));
    request.close();
    session.close();
  });
});
request.end();
