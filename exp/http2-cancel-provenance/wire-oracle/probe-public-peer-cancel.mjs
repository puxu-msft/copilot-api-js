import http2 from 'node:http2'

const variants = ['before-respond', 'after-respond-no-data', 'after-respond-flush-headers', 'after-data']
for (const variant of variants) {
  const server = http2.createServer()
  server.on('sessionError', () => {})
  server.on('stream', (stream) => {
    stream.on('error', () => {})
    if (variant === 'before-respond') {
      stream.close(http2.constants.NGHTTP2_CANCEL)
      return
    }
    stream.respond({ ':status': 200, 'content-type': 'text/event-stream' })
    if (variant === 'after-respond-flush-headers') stream.session?.socket?.write?.('')
    if (variant === 'after-data') stream.write('data: first\n\n')
    setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), 20)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const session = http2.connect(`http://127.0.0.1:${server.address().port}`)
  session.on('error', () => {})
  const req = session.request({ ':path': '/' })
  const events = []
  for (const name of ['response','data','aborted','end','close']) req.on(name, () => events.push({name,rstCode:req.rstCode}))
  req.on('error', (e) => events.push({name:'error',code:e.code,message:e.message,rstCode:req.rstCode}))
  req.end()
  await new Promise((resolve) => req.once('close', resolve))
  console.log(JSON.stringify({variant,events}))
  session.destroy()
  await new Promise((resolve) => server.close(resolve))
}
