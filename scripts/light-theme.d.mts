export function lightColor(color: string): string
export function lightThemeCss(source: string): string
export function lightTheme(): { name: string; enforce: 'pre'; transform(code: string, id: string): { code: string; map: null } | null }
