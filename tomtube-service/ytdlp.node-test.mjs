import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { classifyFailure, createLimiter, createYtDlp, extractArguments, sanitizeToolOutput, searchArguments, YtDlpError } from './ytdlp.mjs'
import { loadConfig } from './config.mjs'

const config = { binary: 'yt-dlp', cacheDir: '/var/lib/tomtube/yt-dlp-cache', jsRuntime: 'deno', remoteComponents: null, playerClients: null, potProviderUrl: 'http://127.0.0.1:4416', cookies: null, maxConcurrent: 2, maxQueued: 2, timeoutMs: 1000, maxOutputBytes: 1024 * 1024 }

function fakeSpawn(behaviour) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)) }
    setImmediate(() => behaviour(child, args))
    return child
  }
  return { spawn, calls }
}

test('yt-dlp is given a fixed watch URL and the search text as one argument after --', () => {
  const args = extractArguments(config, 'dQw4w9WgXcQ')
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(args.at(-2), '--')
  assert.ok(args.includes('--ignore-config'))
  assert.ok(args.includes('--no-playlist'))
  assert.deepEqual(args.slice(args.indexOf('--js-runtimes'), args.indexOf('--js-runtimes') + 2), ['--js-runtimes', 'deno'])
  assert.ok(args.includes('youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'))
  assert.throws(() => extractArguments(config, '--exec=rm'), TypeError)
  const search = searchArguments(config, '--exec rm -rf /', 5)
  assert.equal(search.at(-1), 'ytsearch5:--exec rm -rf /')
  assert.equal(search.at(-2), '--')
  assert.ok(search.includes('--flat-playlist'))
})

test('failures become a code and a message without secrets', () => {
  assert.equal(classifyFailure('ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access').code, 'private')
  assert.equal(classifyFailure('ERROR: [youtube] abc: Sign in to confirm your age.').code, 'age-restricted')
  assert.equal(classifyFailure('ERROR: [youtube] abc: Sign in to confirm you’re not a bot.').code, 'bot-check')
  assert.equal(classifyFailure('ERROR: [youtube] abc: Video unavailable').status, 404)
  assert.equal(classifyFailure('ERROR: HTTP Error 429: Too Many Requests').code, 'rate-limited')
  const unknown = classifyFailure('ERROR: odd failure https://rr1.googlevideo.com/videoplayback?sig=SECRET&pot=TOKEN in /opt/tomtube/secrets/cookies.txt --cookies /x/y')
  assert.equal(unknown.code, 'extraction-failed')
  assert.doesNotMatch(unknown.message, /SECRET|TOKEN|googlevideo|\/opt\/tomtube|\/x\/y/)
  assert.doesNotMatch(sanitizeToolOutput('Cookie: SID=abc\nAuthorization: Bearer xyz'), /SID=abc|xyz/)
})

test('only a few yt-dlp runs at once, and a full queue says busy', async () => {
  const limiter = createLimiter(1, 1)
  let release
  const first = limiter.run(() => new Promise((resolve) => { release = resolve }))
  const second = limiter.run(async () => 'second')
  await assert.rejects(limiter.run(async () => 'third'), (error) => error instanceof YtDlpError && error.code === 'busy')
  assert.equal(limiter.active, 1)
  release('first')
  assert.equal(await first, 'first')
  assert.equal(await second, 'second')
})

test('yt-dlp output is parsed, runs without a shell, and failures and timeouts are reported', async () => {
  const ok = fakeSpawn((child) => { child.stdout.end(JSON.stringify({ id: 'dQw4w9WgXcQ', formats: [] })); child.emit('close', 0) })
  const ytdlp = createYtDlp(config, { spawn: ok.spawn })
  assert.equal((await ytdlp.extract('dQw4w9WgXcQ')).id, 'dQw4w9WgXcQ')
  assert.equal(ok.calls[0].options.shell, false)

  const failing = fakeSpawn((child) => { child.stderr.end('ERROR: [youtube] dQw4w9WgXcQ: Private video'); setTimeout(() => child.emit('close', 1), 5) })
  await assert.rejects(createYtDlp(config, { spawn: failing.spawn }).extract('dQw4w9WgXcQ'), (error) => error.code === 'private' && error.status === 403)

  const hanging = fakeSpawn(() => {})
  await assert.rejects(createYtDlp({ ...config, timeoutMs: 50 }, { spawn: hanging.spawn }).search('x', 1), (error) => error.code === 'timeout')

  const missing = { spawn: () => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {}; setImmediate(() => child.emit('error', Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }))); return child } }
  await assert.rejects(createYtDlp(config, missing).extract('dQw4w9WgXcQ'), (error) => error.code === 'ytdlp-missing')
})

test('the cookie file is copied for each run and the copy is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomtube-cookie-test-'))
  try {
    const cookies = join(dir, 'youtube.cookies')
    await writeFile(cookies, '# Netscape HTTP Cookie File\n')
    let seenCopy = null
    const spawner = fakeSpawn(async (child, args) => {
      seenCopy = args[args.indexOf('--cookies') + 1]
      assert.notEqual(seenCopy, cookies)
      assert.match(await readFile(seenCopy, 'utf8'), /Netscape/)
      child.stdout.end('{"id":"dQw4w9WgXcQ"}')
      child.emit('close', 0)
    })
    await createYtDlp({ ...config, cookies }, { spawn: spawner.spawn }).extract('dQw4w9WgXcQ')
    await assert.rejects(readFile(seenCopy), { code: 'ENOENT' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('account feeds use the training cookies, hand back the updated jar and keep warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tomtube-feed-test-'))
  try {
    const training = '# training jar\n'
    const playback = join(dir, 'playback.cookies')
    await writeFile(playback, '# playback jar\n')
    let copy = null
    const spawner = fakeSpawn(async (child, args) => {
      copy = args[args.indexOf('--cookies') + 1]
      assert.match(await readFile(copy, 'utf8'), /training jar/)
      assert.equal(args.at(-1), ':ythistory')
      await writeFile(copy, '# rotated jar\n')
      child.stderr.write(`WARNING: something about ${playback}\n`)
      child.stdout.end('{"entries":[]}')
      child.emit('close', 0)
    })
    const result = await createYtDlp({ ...config, cookies: playback }, { spawn: spawner.spawn }).feed(':ythistory', 10, training)
    assert.deepEqual(result.data, { entries: [] })
    assert.equal(result.jar, '# rotated jar\n')
    assert.match(result.warnings, /WARNING/)
    assert.doesNotMatch(result.warnings, /playback\.cookies/)
    await assert.rejects(readFile(copy), { code: 'ENOENT' })
    const failing = fakeSpawn((child) => { child.stderr.end('ERROR: This feed requires login. Use --cookies'); child.emit('close', 1) })
    await assert.rejects(createYtDlp(config, { spawn: failing.spawn }).feed(':ytrec', 5, training), (error) => /requires login/.test(error.detail))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the service refuses to start without a strong token', () => {
  assert.throws(() => loadConfig({}), /TOMTUBE_TOKEN is required/)
  assert.throws(() => loadConfig({ TOMTUBE_TOKEN: 'short' }), /at least 32/)
  assert.throws(() => loadConfig({ TOMTUBE_ALLOW_INSECURE_LOOPBACK: 'true', TOMTUBE_HOST: '0.0.0.0' }), /loopback/)
  assert.equal(loadConfig({ TOMTUBE_ALLOW_INSECURE_LOOPBACK: 'true' }).token, '')
  const loaded = loadConfig({ TOMTUBE_TOKEN: 'x'.repeat(40), TOMTUBE_POT_PROVIDER_URL: 'http://127.0.0.1:4416/', TOMTUBE_YTDLP_JS_RUNTIME: 'deno:/usr/local/bin/deno', TOMTUBE_MAX_HEIGHT: '720' })
  assert.equal(loaded.port, 8790)
  assert.equal(loaded.host, '127.0.0.1')
  assert.equal(loaded.maxHeight, 720)
  assert.equal(loaded.ytdlp.potProviderUrl, 'http://127.0.0.1:4416')
  assert.throws(() => loadConfig({ TOMTUBE_TOKEN: 'x'.repeat(40), TOMTUBE_YTDLP_JS_RUNTIME: 'deno; rm -rf /' }), /JS_RUNTIME/)
  assert.throws(() => loadConfig({ TOMTUBE_TOKEN: 'x'.repeat(40), TOMTUBE_YTDLP_PLAYER_CLIENTS: 'web --exec x' }), /PLAYER_CLIENTS/)
  assert.throws(() => loadConfig({ TOMTUBE_TOKEN: 'x'.repeat(40), TOMTUBE_POT_PROVIDER_URL: 'http://user:pw@host' }), /POT_PROVIDER_URL/)
})
