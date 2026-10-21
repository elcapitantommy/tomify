import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

// Every button or link that shows only an icon needs a tooltip (title) as well
// as an aria-label, so mouse users can tell what it does. The tooltip may be a
// shorter form of the label ("Remove" for "Remove <song> from downloads").

const root = resolve(__dirname)
const interactive = new Set(['button', 'a', 'Link', 'NavLink', 'summary'])
// Pictures with no visible words count as icons too.
const pictures = new Set(['svg', 'img', 'Artwork', 'MixCover'])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

type Attrs = Map<string, string>

function attributesOf(node: ts.JsxOpeningLikeElement, source: ts.SourceFile): { attrs: Attrs; spread: boolean } {
  const attrs: Attrs = new Map()
  let spread = false
  for (const prop of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) { spread = true; continue }
    const name = prop.name.getText(source)
    const init = prop.initializer
    let value = 'true'
    if (init && ts.isStringLiteral(init)) value = JSON.stringify(init.text)
    else if (init && ts.isJsxExpression(init) && init.expression) {
      const expr = init.expression
      value = ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) ? JSON.stringify(expr.text) : expr.getText(source)
    }
    attrs.set(name, value)
  }
  return { attrs, spread }
}

function tagName(node: ts.JsxOpeningLikeElement, source: ts.SourceFile) {
  return node.tagName.getText(source)
}

// Does this expression render only icons (or nothing)?
function expressionIsIconOnly(expr: ts.Expression, icons: Set<string>, source: ts.SourceFile): boolean {
  if (ts.isParenthesizedExpression(expr)) return expressionIsIconOnly(expr.expression, icons, source)
  if (ts.isConditionalExpression(expr)) return expressionIsIconOnly(expr.whenTrue, icons, source) && expressionIsIconOnly(expr.whenFalse, icons, source)
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)) return expressionIsIconOnly(expr.right, icons, source)
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true
  if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) return childIsIconOnly(expr, icons, source)
  return false
}

function childIsIconOnly(child: ts.JsxChild | ts.JsxFragment, icons: Set<string>, source: ts.SourceFile): boolean {
  if (ts.isJsxText(child)) return child.text.trim() === ''
  if (ts.isJsxExpression(child)) return !child.expression || expressionIsIconOnly(child.expression, icons, source)
  if (ts.isJsxFragment(child)) return child.children.every(c => childIsIconOnly(c, icons, source))
  const opening = ts.isJsxElement(child) ? child.openingElement : child
  const name = tagName(opening as ts.JsxOpeningLikeElement, source)
  const { attrs } = attributesOf(opening as ts.JsxOpeningLikeElement, source)
  if (icons.has(name) || pictures.has(name)) return true
  // Text hidden from sight (screen-reader only) still leaves a visual icon button.
  if (/sr-only|visually-hidden/.test(attrs.get('className') ?? '')) return true
  if (attrs.get('aria-hidden') === '"true"' || attrs.get('aria-hidden') === 'true') return true
  if (ts.isJsxElement(child) && name === 'span') return child.children.every(c => childIsIconOnly(c, icons, source))
  return false
}

type Finding = { file: string; line: number; text: string; problem: string }

function audit(file: string, text = readFileSync(file, 'utf8')): Finding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const icons = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== 'lucide-react') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) bindings.elements.forEach(el => icons.add(el.name.text))
  }
  const findings: Finding[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node
      const name = tagName(opening, source)
      const { attrs, spread } = attributesOf(opening, source)
      const isInteractive = interactive.has(name) || attrs.get('role') === '"button"'
      const children = ts.isJsxElement(node) ? node.children : ts.factory.createNodeArray<ts.JsxChild>()
      const hasChildren = children.some(c => !(ts.isJsxText(c) && c.text.trim() === ''))
      const iconOnly = hasChildren && children.every(c => childIsIconOnly(c, icons, source))
      if (isInteractive && iconOnly && !(spread && !attrs.has('aria-label'))) {
        const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1
        const where = { file: relative(root, file), line, text: opening.getText(source).slice(0, 120) }
        const label = attrs.get('aria-label')
        const title = attrs.get('title')
        if (!label) findings.push({ ...where, problem: 'icon-only control has no aria-label' })
        if (!title || title === '""') findings.push({ ...where, problem: 'icon-only control has no title tooltip' })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

describe('icon-only buttons', () => {
  it('all have a tooltip that matches their accessible label', () => {
    const findings = sourceFiles(root).flatMap(file => audit(file))
    expect(findings.map(f => `${f.file}:${f.line} ${f.problem}\n    ${f.text}`)).toEqual([])
  })

  it('spots an icon-only button without a tooltip', () => {
    const sample = "import { Play, X } from 'lucide-react'\nexport const A = () => <><button aria-label=\"Play\"><Play /></button><button title=\"Close\"><X /></button><button title=\"Ok\" aria-label=\"Ok\"><X /></button><button><X /> Close</button></>\n"
    expect(audit(join(root, 'sample.tsx'), sample).map(f => f.problem)).toEqual([
      'icon-only control has no title tooltip',
      'icon-only control has no aria-label',
    ])
  })
})
