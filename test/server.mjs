// Static server for the demo: demo/ at "/", dist/<engine>/ at "/<engine>/". Run directly to browse it.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { ENGINE_NAMES, root } from '../scripts/common.mjs'

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.png': 'image/png' }

function resolveFile(pathname) {
  const [, first, ...rest] = pathname.split('/')
  if (ENGINE_NAMES.includes(first)) return join(root, 'dist', first, ...rest)
  return join(root, 'demo', pathname === '/' ? 'index.html' : pathname)
}

export async function startServer(port = 0) {
  const server = createServer(async (request, response) => {
    const path = normalize(resolveFile(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)))
    if (!path.startsWith(join(root, 'demo') + sep) && !path.startsWith(join(root, 'dist') + sep)) return response.writeHead(403).end('forbidden')
    try {
      const body = await readFile(path)
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'content-length': body.length })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise((done) => server.listen(port, '127.0.0.1', done))
  return { server, port: server.address().port }
}

if (import.meta.main) {
  const { port } = await startServer(Number(process.env.PORT ?? 8080))
  console.log(`demo on http://127.0.0.1:${port}/`)
}
