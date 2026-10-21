import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
afterEach(cleanup)

// jsdom has no PointerEvent, so pointer events lose their coordinates and pointerId in tests.
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0 }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent
}

// jsdom's Blob (and so File) has no text(); read it the old way.
if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}
