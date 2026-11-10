import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Starts the real agent (recovery-agent/index.mjs) with nothing but temporary folders behind it, to check what each
// listener answers. Nothing here downloads anything: qBittorrent, SABnzbd and Jellyfin are not configured.
const agent = fileURLToPath(new URL('./index.mjs', import.meta.url))
const TOKEN = 'r'.repeat(40)

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

async function startAgent(extraEnv) {
  const root = mkdtempSync(join(tmpdir(), 'tomify-agent-listener-'))
  const web = join(root, 'tomifin-web')
  mkdirSync(web)
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Tomifin</title>')
  const port = await freePort()
  const env = {
    PATH: process.env.PATH, HOME: root, TOMIFY_RECOVERY_TOKEN: TOKEN, TOMIFY_RECOVERY_PORT: String(port),
    TOMIFY_RECOVERY_DIR: join(root, 'recovered'), TOMIFY_RECOVERY_STATE_DIR: join(root, 'state'), TOMIFY_TOMIFIN_WEB_DIR: web,
    TOMIFY_TOMIFIN_SESSION_SECRET: 's'.repeat(64), ...extraEnv,
  }
  const child = spawn(process.execPath, [agent], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const started = Date.now()
  while (!output.includes('Tomify recovery agent listening') || (extraEnv.TOMIFY_TOMIFIN_LOCAL_PORT && !/Tomifin (listening|local listener is off)/.test(output))) {
    if (child.exitCode !== null || Date.now() - started > 15_000) { child.kill('SIGKILL'); throw new Error(`The agent did not start:\n${output}`) }
    await new Promise((done) => setTimeout(done, 50))
  }
  return { port, output: () => output, stop: () => new Promise((done) => { child.once('exit', done); child.kill('SIGTERM') }) }
}

test('the Recovery listener answers 404 to every /v1/tomifin/* request, with or without the Recovery token', async () => {
  const localPort = await freePort()
  const running = await startAgent({ TOMIFY_TOMIFIN_LOCAL_PORT: String(localPort) })
  try {
    for (const authorization of [`Bearer ${TOKEN}`, null, 'Bearer wrong-token']) {
      for (const method of ['GET', 'POST']) {
        for (const path of ['/v1/tomifin', '/v1/tomifin/', '/v1/tomifin/login', '/v1/tomifin/session', '/v1/tomifin/downloads', '/v1/tomifin/anything?x=1']) {
          const response = await fetch(`http://127.0.0.1:${running.port}${path}`, { method, headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: method === 'POST' ? JSON.stringify({ username: 'tom', password: 'x', session: 'c'.repeat(32) }) : undefined })
          assert.equal(response.status, 404, `${method} ${path} (${authorization ? 'token' : 'no token'})`)
          assert.deepEqual(await response.json(), { error: 'not-found' })
        }
      }
    }
    // Recovery itself is unchanged.
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/health`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/v1/status`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' })).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/v1/status`, { method: 'POST', body: '{}' })).status, 401)
    // Tomifin still answers on its own listener: sign-in is required there.
    assert.match(running.output(), new RegExp(`Tomifin listening on http://127\\.0\\.0\\.1:${localPort}`))
    const session = await fetch(`http://127.0.0.1:${localPort}/api/tomifin/session`)
    assert.equal(session.status, 401)
    assert.equal((await fetch(`http://127.0.0.1:${localPort}/`)).status, 200)
  } finally { await running.stop() }
})

test('when the Tomifin port is taken, the agent logs one clear line and Recovery keeps running', async () => {
  const taken = createServer()
  await new Promise((done) => taken.listen(0, '127.0.0.1', done))
  const localPort = taken.address().port
  const running = await startAgent({ TOMIFY_TOMIFIN_LOCAL_PORT: String(localPort) })
  try {
    assert.match(running.output(), new RegExp(`Tomifin local listener is off: 127\\.0\\.0\\.1:${localPort} is already in use by another service\\. Set TOMIFY_TOMIFIN_LOCAL_PORT`))
    assert.equal((await fetch(`http://127.0.0.1:${running.port}/health`)).status, 200)
  } finally {
    await running.stop()
    await new Promise((done) => taken.close(done))
  }
})
