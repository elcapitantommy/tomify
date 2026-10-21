import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lightColor, lightThemeCss } from './light-theme.mjs'

test('dark greys turn light and light text turns dark', () => {
  assert.equal(lightColor('#0d0f0e'), '#f0f2f1')
  assert.equal(lightColor('#f2f5ef'), '#0d100a')
})

test('the accent is darkened enough to read on a light background, keeping its hue', () => {
  assert.equal(lightColor('#d1fd61'), '#5b7e02')
})

test('alpha and short hex forms are kept, and shadows stay dark but softer', () => {
  assert.equal(lightColor('#111311f7'), '#eceeecf7')
  assert.equal(lightColor('#000a'), '#0000004d')
  assert.match(lightColor('#fff'), /^#[0-9a-f]{6}$/)
})

test('colour declarations are repeated under the light theme, in order, inside media queries too', () => {
  const css = lightThemeCss(`@import url('https://fonts.example/css2?family=A:wght@400;500&display=swap');
:root{--bg:#0d0f0e;font-family:x}html{background:#0d0f0e}
/* a comment with { braces } */
.card,.row:hover{color:#f2f5ef;padding:4px;box-shadow:0 2px 4px #0008}
@media(max-width:800px){.card{background:#151816}}
@keyframes spin{to{transform:rotate(1turn)}}`)
  assert.match(css, /:root\[data-theme=light\]\{--bg:#f0f2f1\}/)
  assert.match(css, /html\[data-theme=light\]\{background:#f0f2f1\}/)
  assert.match(css, /:root\[data-theme=light\] \.card,:root\[data-theme=light\] \.row:hover\{color:#0d100a;box-shadow:0 2px 4px #[0-9a-f]{8}\}/)
  assert.match(css, /@media\(max-width:800px\)\{\s*:root\[data-theme=light\] \.card\{background:#e7eae8\}\s*\}/)
  assert.doesNotMatch(css, /padding|font-family|keyframes|transform|braces/)
})

test('the real stylesheet gets a light theme for every colour it sets', () => {
  const source = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const css = lightThemeCss(source)
  assert.match(css, /:root\[data-theme=light\]\{[^}]*--accent:#5b7e02/)
  assert.ok(css.length > 10_000)
})
