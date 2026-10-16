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
})
