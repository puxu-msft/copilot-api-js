import http2 from 'node:http2'

const variants = ['close-cancel', 'destroy-error', 'handle-rst-cancel']

for (const variant of variants) {
  const server = http2.createServer()
  let serverSymbols = []
  server.on('sessionError', () => {})
  server.on('stream', (stream) => {
    stream.on('error', () => {})
    stream.respond({ ':status': 200, 'content-type': 'text/event-stream' })
    stream.write('data: first\n\n')
    setTimeout(() => {
      if (variant === 'close-cancel') stream.close(http2.constants.NGHTTP2_CANCEL)
      else if (variant === 'destroy-error') stream.destroy(new Error('boom'))
      else {
        serverSymbols = Object.getOwnPropertySymbols(stream).map((s) => String(s))
        const handleSymbol = Object.getOwnPropertySymbols(stream).find((s) => String(s).includes('kHandle'))
        const handle = handleSymbol ? stream[handleSymbol] : undefined
        if (typeof handle?.rstStream === 'function') handle.rstStream(http2.constants.NGHTTP2_CANCEL)
        else stream.close(http2.constants.NGHTTP2_CANCEL)
      }
    }, 20)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const session = http2.connect(`http://127.0.0.1:${port}`)
  const req = session.request({ ':path': '/' })
  const events = []
  for (const name of ['response', 'data', 'aborted', 'end', 'close']) req.on(name, () => events.push({ name, rstCode: req.rstCode }))
  req.on('error', (error) => events.push({ name: 'error', code: error.code, message: error.message, rstCode: req.rstCode }))
  req.end()
  await new Promise((resolve) => req.once('close', resolve))
  console.log(JSON.stringify({ variant, events, serverSymbols }))
  session.destroy()
  await new Promise((resolve) => server.close(resolve))
}
