import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

function rulesFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?<=^|[}\\s,])${escaped}(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map(match => match[1])
}

describe('seek bar layout', () => {
  it('gives the time labels a fixed width with even-width digits so the slider never resizes', () => {
    const rule = rulesFor('.seek>.seek-time').join(';')
    expect(rule).toMatch(/flex:none/)
    expect(rule).toMatch(/min-width:var\(--seek-time-width,4ch\)/)
    expect(rule).toMatch(/font-variant-numeric:tabular-nums/)
  })

  it('keeps the elapsed time hugging the slider from the left and the total from the right', () => {
    expect(rulesFor('.seek>.seek-time.elapsed').some(rule => /text-align:right/.test(rule))).toBe(true)
    expect(rulesFor('.seek>.seek-time.total').some(rule => /text-align:left/.test(rule))).toBe(true)
  })

  it('no longer has a phone-only label width that could fight the shared one', () => {
    expect(css).not.toContain('.mobile-player-progress .seek span{')
  })
})
