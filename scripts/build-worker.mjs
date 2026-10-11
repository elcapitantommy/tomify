import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const outputDirectory = new URL('../dist/', import.meta.url)
const workerPath = new URL('../dist/server/index.js', import.meta.url)
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === 'server' || entry.name === '.openai') continue
    const path = join(directory, entry.name)
    files.push(...(entry.isDirectory() ? await collectFiles(path) : [path]))
  }

  return files
}

const root = outputDirectory.pathname.replace(/^\/(.:\/)/, '$1')
const assets = Object.fromEntries(
  await Promise.all(
    (await collectFiles(root)).map(async (path) => {
      const pathname = `/${relative(root, path).split(sep).join('/')}`
      return [pathname, { body: (await readFile(path)).toString('base64'), type: mimeTypes[extname(path)] ?? 'application/octet-stream' }]
    }),
  ),
)

const worker = `const assets = ${JSON.stringify(assets)}

function decode(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)

    if (pathname === '/navidrome' || pathname.startsWith('/navidrome/')) {
      const upstreamPath = pathname.slice('/navidrome'.length) || '/'
      const upstream = new URL(`https://tomify.tomdixon.uk${upstreamPath}`)
      upstream.search = url.search
      const headers = new Headers(request.headers)
      headers.delete('host')
      headers.delete('origin')
      return fetch(upstream, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
        redirect: 'follow',
      })
    }

    if (pathname === '/') pathname = '/index.html'

    let asset = assets[pathname]
    if (!asset && request.method === 'GET' && request.headers.get('accept')?.includes('text/html')) {
      asset = assets['/index.html']
    }
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })

    const headers = new Headers({ 'content-type': asset.type })
    headers.set('cache-control', pathname === '/index.html' || pathname === '/sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable')
    return new Response(request.method === 'HEAD' ? null : decode(asset.body), { headers })
  },
}
`

await writeFile(workerPath, worker)
