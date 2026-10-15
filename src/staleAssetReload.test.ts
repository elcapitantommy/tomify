import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8')
const source = html.match(/<script>([\s\S]*?)<\/script>/)![1]

function failLoad(src: string) {
  const script = document.createElement('script')
  script.src = src
  document.head.appendChild(script)
  script.dispatchEvent(new Event('error'))
  script.remove()
}

describe('stale asset recovery', () => {
  const reload = vi.fn()
  const update = vi.fn().mockResolvedValue(undefined)

  beforeAll(() => {
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, configurable: true })
    Object.defineProperty(navigator, 'serviceWorker', { value: { getRegistrations: () => Promise.resolve([{ update }]) }, configurable: true })
    new Function(source)()
  })
  beforeEach(() => { reload.mockClear(); update.mockClear(); sessionStorage.clear() })

  it('updates the service worker and reloads once when a hashed asset fails to load', async () => {
    failLoad('https://app.example/assets/index-old.js')
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalled()

    failLoad('https://app.example/assets/index-old.js')
    await new Promise(r => setTimeout(r, 0))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('ignores failures outside the build assets', async () => {
    failLoad('https://app.example/rest/getCoverArt?id=1')
    await new Promise(r => setTimeout(r, 0))
    expect(reload).not.toHaveBeenCalled()
  })
})
