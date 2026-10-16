import { describe, expect, it } from 'vitest'
import { fitWithin, prepareArtworkUpload } from './artwork-upload'

describe('artwork upload', () => {
  it('shrinks large images to 1200px on their longest side without enlarging small ones', () => {
    expect(fitWithin(3000, 2000)).toEqual({ width: 1200, height: 800 })
    expect(fitWithin(1500, 3000)).toEqual({ width: 600, height: 1200 })
    expect(fitWithin(500, 500)).toEqual({ width: 500, height: 500 })
  })

  it('refuses files that are not images', async () => {
    await expect(prepareArtworkUpload(new File(['x'], 'notes.txt', { type: 'text/plain' }))).rejects.toThrow('Choose an image file.')
  })
})
