import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

// Tomify for Windows (desktop/) has its settings spread over Rust, JSON and the site; these keep them in step.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const main = read('desktop/src-tauri/src/main.rs')
const build = read('desktop/src-tauri/build.rs')
const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'))
const capability = JSON.parse(read('desktop/src-tauri/capabilities/tomify-site.json'))
const cargo = read('desktop/src-tauri/Cargo.toml')
const appUrl = main.match(/const APP_URL: &str = "([^"]+)"/)[1]

test('the app opens the hosted site, and only that site can use the app', () => {
  assert.equal(appUrl, 'https://app.tomify.tomdixon.uk/')
  assert.deepEqual(capability.remote.urls, [`${appUrl}*`])
  assert.equal(capability.local, false)
  assert.deepEqual(capability.windows, ['main'])
  assert.match(main, /WebviewWindowBuilder::new\(app, "main"/)
})

test('the mini player commands are declared, registered, granted and the ones the site calls', () => {
  const declared = JSON.parse(build.match(/commands\((&\[[^\]]*\])\)/)[1].slice(1))
  const registered = main.match(/generate_handler!\[([^\]]*)\]/)[1].split(',').map((name) => name.trim()).filter(Boolean)
  const granted = capability.permissions.filter((permission) => permission.startsWith('allow-')).map((permission) => permission.slice(6).replaceAll('-', '_'))
  const called = [...read('src/stores/miniPlayer.ts').matchAll(/invoke\('([a-z_]+)'\)/g)].map((match) => match[1])
  assert.deepEqual(declared.sort(), ['enter_mini_player', 'exit_mini_player'])
  assert.deepEqual(registered.sort(), declared)
  assert.deepEqual(granted.sort(), declared)
  assert.deepEqual([...new Set(called)].sort(), declared)
  // Nothing else from Tauri is open to the site except dragging the mini player.
  assert.deepEqual(capability.permissions.filter((permission) => !permission.startsWith('allow-')), ['core:window:allow-start-dragging'])
})

test('the mini player remembers where it was left, on leaving it and on closing the app', () => {
  const spot = read('desktop/src-tauri/src/mini_spot.rs')
  assert.match(main, /^mod mini_spot;/m)
  assert.match(main, /mini_spot::place\(load_mini_spot\(/)
  // Saved when the full window comes back, and when the app is closed as the mini player.
  assert.match(main.slice(main.indexOf('fn exit_mini_player')), /save_mini_spot\(/)
  assert.match(main, /WindowEvent::CloseRequested[\s\S]*save_mini_spot\(/)
  // One size for the mini player, defined beside the code that places it.
  assert.match(spot, /pub const MINI_WIDTH: f64 = 360\.0;/)
  assert.match(spot, /pub const MINI_HEIGHT: f64 = 168\.0;/)
  assert.doesNotMatch(main, /const MINI_(WIDTH|HEIGHT)/)
})

test('installer settings: version in step, icons present, Windows media keys on', () => {
  assert.equal(conf.version, cargo.match(/^version = "([^"]+)"/m)[1])
  assert.equal(conf.app.withGlobalTauri, true)
  assert.deepEqual(conf.bundle.targets.sort(), ['msi', 'nsis'])
  for (const icon of conf.bundle.icon) assert.ok(existsSync(new URL(`../desktop/src-tauri/${icon}`, import.meta.url)), icon)
  // The desktop icon is the rounded tile with the skull from the favicon, not the PWA's T.
  const iconSource = readFileSync(new URL('../desktop/icon.svg', import.meta.url), 'utf8')
  const skull = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8').match(/<path d="([^"]+)"/)[1]
  assert.ok(iconSource.includes(`d="${skull}"`), 'desktop/icon.svg uses the favicon skull')
  assert.match(iconSource, /<rect [^>]*rx="\d+"/)
  // Setting browser arguments replaces wry's defaults, so they must be kept.
  assert.match(main, /--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection/)
  assert.match(main, /--enable-features=HardwareMediaKeyHandling/)
})
