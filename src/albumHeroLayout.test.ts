import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8')

function rulesFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?<=^|[}\\s,])${escaped}(?:,[^{]*)?\\{([^}]*)\\}`, 'g'))].map(match => match[1])
}

function remSizes(rule: string) {
  return [...rule.matchAll(/([\d.]+)rem/g)].map(match => Number(match[1]))
}

describe('album header layout', () => {
  it('lines the album label up with the top of the cover', () => {
    expect(rulesFor('.album-hero').some(rule => /align-items:start/.test(rule))).toBe(true)
  })

  it('keeps album titles smaller than the shared detail heading, and long titles smaller still', () => {
    const shared = Math.max(...rulesFor('.detail-hero h1').flatMap(remSizes))
    const album = Math.max(...rulesFor('.album-hero h1').flatMap(remSizes))
    const long = Math.max(...rulesFor('.album-hero h1.long-title').flatMap(remSizes))
    expect(album).toBeLessThan(shared)
    expect(long).toBeLessThan(album)
  })
})
