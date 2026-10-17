import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./install-agent-release.sh', import.meta.url))
const serviceExample = fileURLToPath(new URL('../recovery-agent/tomify-recovery.service.example', import.meta.url))
const skip = process.platform === 'win32' && 'the release installer runs on Debian and needs POSIX symlinks'

function writeExecutable(path, contents) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function createArchive(root, sha, { extra } = {}) {
  const payload = join(root, `payload-${sha}`)
  mkdirSync(join(payload, 'recovery-agent'), { recursive: true })
  mkdirSync(join(payload, 'shared'), { recursive: true })
  writeFileSync(join(payload, 'recovery-agent', 'index.mjs'), '// test agent\n')
  // An archive's own unit file is never installed, so make this one obviously wrong.
  writeFileSync(join(payload, 'recovery-agent', 'tomify-recovery.service.example'), '[Service]\nUser=root\nExecStart=/bin/sh -c id\n')
  writeFileSync(join(payload, 'shared', 'quality.mjs'), '// shared quality\n')
  writeFileSync(join(payload, 'package.json'), '{"name":"tomify"}\n')
  const members = ['recovery-agent', 'shared', 'package.json']
  if (extra) members.push(extra(payload))
  const archive = join(root, `tomify-agent-${sha}.tar.gz`)
  const result = spawnSync('tar', ['-czf', archive, '-C', payload, ...members], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return archive
}

function setup({ fresh = false } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'tomify-agent-install-'))
  const root = join(temp, 'root')
  const bin = join(temp, 'bin')
  const home = join(root, 'usr', 'local', 'lib', 'tomify-agent')
  const releases = join(home, 'releases')
  const envFile = join(root, 'etc', 'tomify', 'recovery-agent.env')
  const serviceFile = join(root, 'etc', 'systemd', 'system', 'tomify-recovery.service')
  const log = join(temp, 'calls.log')
  mkdirSync(bin, { recursive: true })
  mkdirSync(releases, { recursive: true })
  mkdirSync(dirname(envFile), { recursive: true })
  mkdirSync(dirname(serviceFile), { recursive: true })
  writeFileSync(log, '')
  writeExecutable(join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "systemctl $*" >> "$STUB_LOG"\n')
  writeExecutable(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf \'{"ok":true,"version":"%s"}\\n\' "$STUB_HEALTH_VERSION"\n')
  // The unit an older layout left behind.
  writeFileSync(serviceFile, '[Service]\nExecStart=/usr/bin/node /opt/tomify/current/recovery-agent/index.mjs\n')

  if (!fresh) {
    const oldShas = ['1111111', '2222222', '3333333', '4444444', '5555555', '6666666']
    oldShas.forEach((sha, index) => {
      const path = join(releases, sha)
      mkdirSync(path)
      const time = new Date(1_700_000_000_000 + index * 1_000)
      utimesSync(path, time, time)
    })
    symlinkSync(join(releases, '6666666'), join(home, 'current'), 'dir')
    symlinkSync(join(releases, '5555555'), join(home, 'previous'), 'dir')
  }
  writeFileSync(envFile, 'TOMIFY_RECOVERY_TOKEN=keep-this-value\nTOMIFY_VERSION=6666666\nTOMIFY_RECOVERY_DIR=/srv/music-recovery\n')

  const baseEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    STUB_LOG: log,
    TOMIFY_INSTALL_HEALTH_TIMEOUT: '0',
  }
  const run = (args, healthVersion, env = {}, scriptPath = script) => spawnSync('bash', [scriptPath, '--dry-run', '--root', root, ...args], {
    env: { ...baseEnv, STUB_HEALTH_VERSION: healthVersion, ...env },
    encoding: 'utf8',
  })
  return { temp, root, home, releases, envFile, serviceFile, log, run }
}

test('dry-run installs a release, updates version, swaps the symlink, and retains five releases', { skip }, () => {
  const fixture = setup()
  const sha = 'abcdef1'
  const archive = createArchive(fixture.temp, sha)
  const result = fixture.run(['--archive', archive, '--sha', sha], sha)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`Deployed Tomify recovery agent ${sha}`))
  assert.equal(realpathSync(join(fixture.home, 'current')), join(fixture.releases, sha))
  assert.equal(realpathSync(join(fixture.home, 'previous')), join(fixture.releases, '6666666'))
  assert.equal(lstatSync(join(fixture.home, 'current')).isSymbolicLink(), true)
  assert.equal(readdirSync(fixture.releases).filter((name) => !name.startsWith('.')).length, 5)
  assert.deepEqual(readdirSync(fixture.releases).filter((name) => name.startsWith('.')), [])
  assert.equal(existsSync(join(fixture.releases, '1111111')), false)
  assert.equal(readFileSync(join(fixture.releases, sha, 'recovery-agent', 'index.mjs'), 'utf8'), '// test agent\n')
  assert.equal(readFileSync(fixture.envFile, 'utf8'), 'TOMIFY_RECOVERY_TOKEN=keep-this-value\nTOMIFY_VERSION=abcdef1\nTOMIFY_RECOVERY_DIR=/srv/music-recovery\n')
  assert.match(readFileSync(fixture.log, 'utf8'), /systemctl daemon-reload\nsystemctl restart tomify-recovery/)
})

test('the systemd unit comes from the installer, never from the archive, and matches the documented example', { skip }, () => {
  const fixture = setup()
  const sha = 'abcdef1'
  const result = fixture.run(['--archive', createArchive(fixture.temp, sha), '--sha', sha], sha)
  assert.equal(result.status, 0, result.stderr)
  const unit = readFileSync(fixture.serviceFile, 'utf8')
  assert.equal(unit, readFileSync(serviceExample, 'utf8').replace(/\r\n/g, '\n'))
  assert.match(unit, /^User=tom$/m)
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/tomify-agent\/current\/recovery-agent\/index\.mjs$/m)
  assert.doesNotMatch(unit, /User=root|\/bin\/sh/)
})

test('a failed health check restores the previous symlink and version', { skip }, () => {
  const fixture = setup()
  const goodSha = 'abcdef1'
  let result = fixture.run(['--archive', createArchive(fixture.temp, goodSha), '--sha', goodSha], goodSha)
  assert.equal(result.status, 0, result.stderr)

  const badSha = 'abcdef2'
  result = fixture.run(['--archive', createArchive(fixture.temp, badSha), '--sha', badSha], goodSha)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /did not become healthy.*restored the previous release/)
  assert.equal(realpathSync(join(fixture.home, 'current')), join(fixture.releases, goodSha))
  assert.equal(realpathSync(join(fixture.home, 'previous')), join(fixture.releases, '6666666'))
  assert.match(readFileSync(fixture.envFile, 'utf8'), /^TOMIFY_VERSION=abcdef1$/m)
})

test('a failed first deploy into the new directory puts the old unit and version back', { skip }, () => {
  const fixture = setup({ fresh: true })
  const oldUnit = readFileSync(fixture.serviceFile, 'utf8')
  const sha = 'abcdef1'
  const result = fixture.run(['--archive', createArchive(fixture.temp, sha), '--sha', sha], 'something-else')
  assert.equal(result.status, 1)
  assert.equal(readFileSync(fixture.serviceFile, 'utf8'), oldUnit)
  assert.equal(existsSync(join(fixture.home, 'current')), false)
  assert.match(readFileSync(fixture.envFile, 'utf8'), /^TOMIFY_VERSION=6666666$/m)
})

test('archives with links or unexpected members are refused before anything is extracted', { skip }, () => {
  const fixture = setup()
  const cases = [
    ['abcdef3', (payload) => { symlinkSync('/etc', join(payload, 'shared', 'etc')); return 'shared' }, /not a regular file or directory/],
    ['abcdef4', (payload) => { writeFileSync(join(payload, 'evil.sh'), 'id\n'); return 'evil.sh' }, /unexpected archive member: evil\.sh/],
  ]
  for (const [sha, extra, message] of cases) {
    const result = fixture.run(['--archive', createArchive(fixture.temp, sha, { extra }), '--sha', sha], sha)
    assert.equal(result.status, 1, sha)
    assert.match(result.stderr, message)
    assert.equal(existsSync(join(fixture.releases, sha)), false)
    assert.equal(realpathSync(join(fixture.home, 'current')), join(fixture.releases, '6666666'))
  }
  assert.deepEqual(readdirSync(fixture.releases).filter((name) => name.startsWith('.')), [])
})

test('outside test mode the installer needs root and refuses --root', { skip }, () => {
  const plain = (args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' })
  if (process.getuid?.() !== 0) assert.match(plain(['--rollback']).stderr, /run this installer with sudo/)
  assert.equal(plain(['--root', '/tmp', '--rollback']).status, 1)
})

test('explicit rollback swaps current and previous releases', { skip }, () => {
  const fixture = setup()
  const result = fixture.run(['--rollback'], '5555555')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(realpathSync(join(fixture.home, 'current')), join(fixture.releases, '5555555'))
  assert.equal(realpathSync(join(fixture.home, 'previous')), join(fixture.releases, '6666666'))
  assert.match(readFileSync(fixture.envFile, 'utf8'), /^TOMIFY_VERSION=5555555$/m)
})

test('bootstrap installs the installer and a sudoers rule for exactly that path, and the installed copy cannot bootstrap', { skip }, () => {
  const fixture = setup()
  const result = fixture.run(['--bootstrap'], '', { SUDO_USER: 'tom' })
  assert.equal(result.status, 0, result.stderr)
  const installed = join(fixture.root, 'usr', 'local', 'sbin', 'tomify-install-agent')
  assert.equal(readFileSync(installed, 'utf8'), readFileSync(script, 'utf8'))
  assert.equal(statSync(installed).mode & 0o777, 0o755)
  const rule = join(fixture.root, 'etc', 'sudoers.d', 'tomify-deploy')
  assert.equal(readFileSync(rule, 'utf8'), 'tom ALL=(root) NOPASSWD: /usr/local/sbin/tomify-install-agent\n')
  assert.equal(statSync(rule).mode & 0o777, 0o440)

  const again = fixture.run(['--bootstrap'], '', { SUDO_USER: 'tom' }, installed)
  assert.equal(again.status, 1)
  assert.match(again.stderr, /not the installed one/)
  for (const user of ['', 'root', 'tom ALL=(ALL) ALL #']) {
    const refused = fixture.run(['--bootstrap'], '', { SUDO_USER: user })
    assert.equal(refused.status, 1, JSON.stringify(user))
    assert.match(refused.stderr, /must be run through sudo by the deploy user/)
  }
})
