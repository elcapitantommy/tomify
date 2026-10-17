import { json } from './http.ts'

export function schemaOutOfDateResponse(error: unknown): Response | null {
  const match = /no such (table|column): ([A-Za-z0-9_.]+)/.exec(error instanceof Error ? error.message : String(error))
  if (!match) return null
  return json({
    error: 'schema-out-of-date',
    message: 'The Tomify database is missing the ' + match[1] + ' ' + match[2] + '. Apply the D1 migrations (pnpm run deploy) and try again.',
    missing: { kind: match[1], name: match[2] },
  }, 503)
}
