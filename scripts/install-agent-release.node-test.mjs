import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./install-agent-release.sh', import.meta.url))
const activate = fileURLToPath(new URL('./tomify-agent-activate.sh', import.meta.url))
const serviceExample = fileURLToPath(new URL('../recovery-agent/tomify-recovery.service.example', import.meta.url))
const skip = process.platform === 'win32' && 'the release installer runs on Debian and needs POSIX symlinks'

function writeExecutable(path, contents) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function createArchive(root, sha, { unit = null } = {}) {
  const payload = join(root, `payload-${sha}`)
  mkdirSync(join(payload, 'recovery-agent'), { recursive: true })
  mkdirSync(join(payload, 'shared'), { recursive: true })
  mkdirSync(join(payload, 'scripts'), { recursive: true })
  writeFileSync(join(payload, 'recovery-agent', 'index.mjs'), '// test agent\n')
  if (unit) writeFileSync(join(payload, 'recovery-agent', 'tomify-recovery.service.example'), unit)
  else cpSync(serviceExample, join(payload, 'recovery-agent', 'tomify-recovery.service.example'))
  writeFileSync(join(payload, 'shared', 'quality.mjs'), '// shared quality\n')
  cpSync(script, join(payload, 'scripts', 'install-agent-release.sh'))
  writeFileSync(join(payload, 'package.json'), '{"name":"tomify"}\n')
  const archive = join(root, `tomify-agent-${sha}.tar.gz`)
  const result = spawnSync('tar', ['-czf', archive, '-C', payload, 'recovery-agent', 'shared', 'scripts', 'package.json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return archive
}

function setup({ legacyLayout = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'tomify-agent-install-'))
  const root = join(temp, 'root')
  const bin = join(temp, 'bin')
  const releases = join(root, 'opt', 'tomify', 'releases')
  const envFile = join(root, 'etc', 'tomify', 'recovery-agent.env')
  const log = join(temp, 'calls.log')
  mkdirSync(bin, { recursive: true })
  mkdirSync(releases, { recursive: true })
  mkdirSync(dirname(envFile), { recursive: true })
  writeFileSync(log, '')
  writeExecutable(join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\n')
  writeExecutable(join(bin, 'tomify-agent-activate'), `#!/usr/bin/env bash\nexec bash ${JSON.stringify(activate)} --dry-run --root ${JSON.stringify(root)} "$@"\n`)
  mkdirSync(join(root, 'etc', 'systemd', 'system'), { recursive: true })
  writeExecutable(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf \'{"ok":true,"version":"%s"}\\n\' "$STUB_HEALTH_VERSION"\n')

  const oldShas = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666']
  oldShas.forEach((sha, index) => {
    const path = join(releases, sha)
    mkdirSync(path)
    const time = new Date(1_700_000_000_000 + index * 1_000)
    utimesSync(path, time, time)
  })
  const current = join(root, 'opt', 'tomify', 'current')
  const previous = join(root, 'opt', 'tomify', 'previous')
  if (legacyLayout) {
    mkdirSync(join(root, 'opt', 'tomify', 'recovery-agent'), { recursive: true })
    mkdirSync(join(root, 'opt', 'tomify', 'shared'), { recursive: true })
    writeFileSync(join(root, 'opt', 'tomify', 'recovery-agent', 'index.mjs'), '// legacy agent\n')
    writeFileSync(join(root, 'opt', 'tomify', 'shared', 'quality.mjs'), '// legacy shared\n')
  } else {
    symlinkSync(join(releases, '6666666'), current, 'dir')
    symlinkSync(join(releases, '5555555'), previous, 'dir')
  }
  writeFileSync(envFile, 'TOMIFY_RECOVERY_TOKEN=keep-this-value\nTOMIFY_VERSION=6666666\nTOMIFY_RECOVERY_DIR=/srv/music-recovery\n')

  const baseEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    STUB_LOG: log,
    TOMIFY_INSTALL_HEALTH_TIMEOUT: '0',
  }
  const run = (args, healthVersion) => spawnSync('bash', [script, '--dry-run', '--root', root, ...args], {
    env: { ...baseEnv, STUB_HEALTH_VERSION: healthVersion },
    encoding: 'utf8',
  })
  const serviceFile = join(root, 'etc', 'systemd', 'system', 'tomify-recovery.service')
  return { temp, root, releases, envFile, serviceFile, log, run, baseEnv }
}

test('dry-run installs a release, updates version, swaps the symlink, and retains five releases', { skip }, () => {
  const fixture = setup()
  const sha = 'abcdef1'
  const archive = createArchive(fixture.temp, sha)
  const result = fixture.run(['--archive', archive, '--sha', sha], sha)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`Deployed Tomify recovery agent ${sha}`))
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'current')), join(fixture.releases, sha))
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'previous')), join(fixture.releases, '6666666'))
  assert.equal(lstatSync(join(fixture.root, 'opt', 'tomify', 'current')).isSymbolicLink(), true)
  assert.equal(readdirSync(fixture.releases).filter((name) => !name.startsWith('.')).length, 5)
  assert.equal(existsSync(join(fixture.releases, '1111111')), false)
  assert.equal(existsSync(join(fixture.releases, sha)), true)
  assert.equal(readFileSync(fixture.envFile, 'utf8'), 'TOMIFY_RECOVERY_TOKEN=keep-this-value\nTOMIFY_VERSION=abcdef1\nTOMIFY_RECOVERY_DIR=/srv/music-recovery\n')
  assert.match(readFileSync(fixture.log, 'utf8'), /systemctl daemon-reload\nsystemctl restart tomify-recovery/)
})

test('a failed health check restores the previous symlink and version', { skip }, () => {
  const fixture = setup()
  const goodSha = 'abcdef1'
  let archive = createArchive(fixture.temp, goodSha)
  let result = fixture.run(['--archive', archive, '--sha', goodSha], goodSha)
  assert.equal(result.status, 0, result.stderr)

  const badSha = 'abcdef2'
  archive = createArchive(fixture.temp, badSha)
  result = fixture.run(['--archive', archive, '--sha', badSha], goodSha)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not become healthy.*restored the previous release/)
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'current')), join(fixture.releases, goodSha))
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'previous')), join(fixture.releases, '6666666'))
  assert.match(readFileSync(fixture.envFile, 'utf8'), /^TOMIFY_VERSION=abcdef1$/m)
})

test('first deployment preserves the mutable layout as a rollback release', { skip }, () => {
  const fixture = setup({ legacyLayout: true })
  const sha = 'abcdef1'
  const archive = createArchive(fixture.temp, sha)
  const result = fixture.run(['--archive', archive, '--sha', sha], sha)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'current')), join(fixture.releases, sha))
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'previous')), join(fixture.releases, 'legacy'))
  assert.equal(readFileSync(join(fixture.releases, 'legacy', 'recovery-agent', 'index.mjs'), 'utf8'), '// legacy agent\n')
  assert.equal(readFileSync(join(fixture.releases, 'legacy', 'shared', 'quality.mjs'), 'utf8'), '// legacy shared\n')
  assert.equal(existsSync(join(fixture.releases, 'legacy', 'scripts', 'install-agent-release.sh')), true)
})

test('explicit rollback swaps current and previous releases', { skip }, () => {
  const fixture = setup()
  const result = fixture.run(['--rollback'], '5555555')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'current')), join(fixture.releases, '5555555'))
  assert.equal(realpathSync(join(fixture.root, 'opt', 'tomify', 'previous')), join(fixture.releases, '6666666'))
  assert.match(readFileSync(fixture.envFile, 'utf8'), /^TOMIFY_VERSION=5555555$/m)
})

test('the service unit comes from the root helper, never from the release archive', { skip }, () => {
  const fixture = setup()
  const sha = 'abcdef1'
  const archive = createArchive(fixture.temp, sha, { unit: '[Service]\nUser=root\nExecStart=/bin/sh -c id\n' })
  const result = fixture.run(['--archive', archive, '--sha', sha], sha)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(fixture.serviceFile, 'utf8'), readFileSync(serviceExample, 'utf8'))
})

test('the root helper only accepts a Git SHA or legacy as the version', { skip }, () => {
  const fixture = setup()
  for (const version of ['abc', 'abcdef1; id', '../../etc', '']) {
    const result = spawnSync('bash', [activate, '--dry-run', '--root', fixture.root, '--version', version], { env: fixture.baseEnv, encoding: 'utf8' })
    assert.equal(result.status, 1, version)
    assert.match(result.stderr, /--version must be/)
  }
  assert.equal(readFileSync(fixture.log, 'utf8'), '')
})

test('the root helper refuses test options under sudo', { skip }, () => {
  const fixture = setup()
  const result = spawnSync('bash', [activate, '--dry-run', '--root', fixture.root, '--version', 'abcdef1'], { env: { ...fixture.baseEnv, SUDO_USER: 'tom' }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /refused under sudo/)
})

test('the root helper clears the version and keeps every other setting', { skip }, () => {
  const fixture = setup()
  const result = spawnSync('bash', [activate, '--dry-run', '--root', fixture.root, '--clear-version'], { env: fixture.baseEnv, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(fixture.envFile, 'utf8'), 'TOMIFY_RECOVERY_TOKEN=keep-this-value\nTOMIFY_RECOVERY_DIR=/srv/music-recovery\n')
})
