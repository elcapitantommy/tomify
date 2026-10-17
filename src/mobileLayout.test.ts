import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

function rulesFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?<=^|[}\\s,])${escaped}(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map(match => match[1])
}
const has = (selector: string, declaration: RegExp) => rulesFor(selector).some(rule => declaration.test(rule))

describe('iPhone layout', () => {
  it('keeps the album hero inside the screen so iOS does not zoom the page out', () => {
    expect(has('.detail-hero', /grid-template-columns:minmax\(0,1fr\)/)).toBe(true)
    expect(has('.hero-actions', /flex-wrap:wrap/)).toBe(true)
    expect(has('.detail-hero .metadata-source', /overflow-wrap:anywhere/)).toBe(true)
    expect(has('.app-shell', /overflow-x:clip/)).toBe(true)
  })

  it('keeps the now playing header clear of the status bar', () => {
    expect(has('.now-playing', /padding-top:calc\(18px \+ env\(safe-area-inset-top\)\)/)).toBe(true)
  })

  it('gives track numbers a fixed, tabular column', () => {
    expect(has('.track-number', /flex:none/)).toBe(true)
    expect(has('.track-number', /font-variant-numeric:tabular-nums/)).toBe(true)
  })
})
