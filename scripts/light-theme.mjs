// The light theme, made from the dark stylesheet at build time so it never falls behind it. Every colour
// declaration in src/styles.css is repeated under :root[data-theme=light] with its colours turned light:
// greys and dark tints swap lightness (dark backgrounds become light ones, light text becomes dark), bright
// colours such as the accent are darkened enough to read on a light background, and shadows stay dark.

const COLOR_PROPERTY = /^(--|color$|background|border|outline|box-shadow|text-shadow|fill$|stroke$|accent-color$|caret-color$|text-decoration-color$|column-rule)/

function hsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function rgb(h, s, l) {
  if (!s) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const channel = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
}

const hex2 = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')

// One colour in its light-theme form. Keeps the hex length style (alpha included).
export function lightColor(color) {
  const digits = color.slice(1)
  const long = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join('') : digits
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(long.slice(at, at + 2), 16) / 255)
  const alpha = long.length === 8 ? long.slice(6) : ''
  const [h, s, l] = hsl(r, g, b)
  // Shadows and dark veils (pure black with alpha) stay dark, just softer; white veils become dark ones.
  const opacity = alpha ? parseInt(alpha, 16) / 255 : 1
  if (opacity < 0.75 && s < 0.1 && l < 0.1) return `#000000${hex2(opacity * 0.45)}`
  if (opacity < 0.75 && s < 0.1 && l > 0.9) return `#000000${alpha}`
  const nextL = s < 0.3 || l < 0.25 ? 1 - l : Math.min(0.32, Math.max(0.2, (1 - l) * 0.8))
  return `#${rgb(h, s, nextL).map(hex2).join('')}${alpha}`
}

const mapColors = (value) => value.replace(/#[0-9a-fA-F]{3,8}\b/g, (match) => [3, 4, 6, 8].includes(match.length - 1) ? lightColor(match) : match)

function lightSelector(selector) {
  return splitTop(selector, ',').map((part) => {
    const item = part.trim()
    if (item.startsWith(':root')) return `:root[data-theme=light]${item.slice(5)}`
    if (/^html\b/.test(item)) return `html[data-theme=light]${item.slice(4)}`
    return `:root[data-theme=light] ${item}`
  }).join(',')
}

// Splits on a separator outside brackets and quotes.
function splitTop(text, separator) {
  const parts = []
  let depth = 0, quote = '', start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) { if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") quote = character
    else if (character === '(' || character === '[') depth += 1
    else if (character === ')' || character === ']') depth -= 1
    else if (character === separator && !depth) { parts.push(text.slice(start, index)); start = index + 1 }
  }
  parts.push(text.slice(start))
  return parts
}

// Where the statement starting at `from` ends: its `{`, or the `;` of an at-rule such as @import.
function statementEnd(css, from) {
  let depth = 0, quote = ''
  for (let index = from; index < css.length; index += 1) {
    const character = css[index]
    if (quote) { if (character === quote) quote = ''; continue }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (!depth && (character === '{' || character === ';')) return index
  }
  return -1
}

function lightRule(selector, body) {
  const declarations = splitTop(body, ';').map((item) => item.trim()).filter(Boolean).filter((item) => {
    const property = item.slice(0, item.indexOf(':')).trim().toLowerCase()
    return COLOR_PROPERTY.test(property)
  }).map(mapColors)
  return declarations.length ? `${lightSelector(selector)}{${declarations.join(';')}}` : ''
}

// Reads rules and @media blocks (other at-rules are skipped) and returns the light-theme CSS.
export function lightThemeCss(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  let index = 0
  const skipBlock = () => { let depth = 0; for (; index < css.length; index += 1) { if (css[index] === '{') depth += 1; else if (css[index] === '}' && --depth === 0) { index += 1; return } } }
  const readBlock = () => {
    const out = []
    while (index < css.length) {
      while (index < css.length && /\s/.test(css[index])) index += 1
      if (index >= css.length) break
      if (css[index] === '}') { index += 1; break }
      const end = statementEnd(css, index)
      if (end < 0) break
      if (css[end] === ';') { index = end + 1; continue }
      const open = end
      const prelude = css.slice(index, open).trim()
      if (prelude.startsWith('@media')) {
        index = open + 1
        const inner = readBlock().filter(Boolean).join('\n')
        if (inner) out.push(`${prelude}{\n${inner}\n}`)
      } else if (prelude.startsWith('@')) {
        index = open
        skipBlock()
      } else {
        const close = css.indexOf('}', open)
        out.push(lightRule(prelude, css.slice(open + 1, close)))
        index = close + 1
      }
    }
    return out
  }
  return readBlock().filter(Boolean).join('\n')
}

// Vite plugin: appends the light theme to src/styles.css.
export function lightTheme() {
  return {
    name: 'tomify-light-theme',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]src[\\/]styles\.css$/.test(id.split('?')[0])) return null
      return { code: `${code}\n/* Light theme (generated by scripts/light-theme.mjs) */\n${lightThemeCss(code)}\n`, map: null }
    },
  }
}
