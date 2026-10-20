import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

function rulesFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?<=^|[}\\s,])${escaped}(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map(match => match[1])
}

describe('now playing layout', () => {
  it('centres the play controls under the artwork', () => {
    expect(rulesFor('.now-playing>.transport').some(rule => /justify-content:center/.test(rule))).toBe(true)
  })

  it('sizes the desktop artwork from the viewport and aligns the title, seek bar and controls to it', () => {
    expect(css).toContain('@media(min-width:801px){\n  .now-playing{--np-chrome')
    expect(rulesFor('.now-playing').some(rule => /--np-col:min\(clamp\(240px,calc\(100vh - var\(--np-chrome\)\),820px\),100%\)/.test(rule))).toBe(true)
    expect(rulesFor('.now-art .artwork').some(rule => /width:var\(--np-col\)/.test(rule) && /height:auto/.test(rule))).toBe(true)
    expect(rulesFor('.now-meta').some(rule => /width:var\(--np-col\)/.test(rule))).toBe(true)
    expect(rulesFor('.now-art').some(rule => /flex:none/.test(rule))).toBe(true)
  })

  it('centres the desktop group vertically instead of pushing the controls to the bottom', () => {
    expect(rulesFor('.now-playing>header').some(rule => /margin-bottom:auto/.test(rule))).toBe(true)
    expect(rulesFor('.now-playing::after').some(rule => /margin-top:auto/.test(rule))).toBe(true)
  })

  it('keeps the phone layout on its own rules', () => {
    expect(rulesFor('.now-art .artwork').some(rule => /width:min\(85vw,55vh\)/.test(rule))).toBe(true)
  })
})
