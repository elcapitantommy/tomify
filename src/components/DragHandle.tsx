import { useRef } from 'react'
import { GripVertical } from 'lucide-react'
import { dropIndex, insertionPoint } from '../lib/reorder'

const EDGE = 70
const SCROLL_STEP = 14

// A grip to drag a row up or down a list (queue, playlist editor). Works with a mouse, a finger or a pen
// through pointer events, and from the keyboard with the arrow keys. The rows are the handle's row and
// its siblings; while dragging, the row being moved and the gap it would drop into are highlighted.
export function DragHandle({ index, count, label, disabled = false, onMove }: { index: number; count: number; label: string; disabled?: boolean; onMove(from: number, to: number): void }) {
  const drag = useRef<{ rows: HTMLElement[]; to: number; pointerId: number } | null>(null)

  const clearMarks = (rows: HTMLElement[]) => rows.forEach((row) => row.classList.remove('drag-source', 'drop-above', 'drop-below'))

  function mark(rows: HTMLElement[], to: number) {
    rows.forEach((row) => row.classList.remove('drop-above', 'drop-below'))
    if (to === index) return
    rows[to]?.classList.add(to < index ? 'drop-above' : 'drop-below')
  }

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || event.button > 0) return
    const row = (event.currentTarget.closest('li, .queue-item') as HTMLElement | null)
    const rows = row?.parentElement ? Array.from(row.parentElement.children) as HTMLElement[] : []
    if (!row || rows.length !== count) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    row.classList.add('drag-source')
    drag.current = { rows, to: index, pointerId: event.pointerId }
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    // Near the top or bottom of the window (or the queue panel), keep scrolling so long lists can be crossed.
    const scroller = current.rows[0]?.closest('.queue-list') as HTMLElement | null
    if (event.clientY < EDGE) (scroller ?? window).scrollBy(0, -SCROLL_STEP)
    else if (event.clientY > window.innerHeight - EDGE) (scroller ?? window).scrollBy(0, SCROLL_STEP)
    const midpoints = current.rows.map((row) => { const box = row.getBoundingClientRect(); return box.top + box.height / 2 })
    current.to = dropIndex(index, insertionPoint(midpoints, event.clientY))
    mark(current.rows, current.to)
  }

  function finish(event: React.PointerEvent<HTMLButtonElement>, commit: boolean) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    clearMarks(current.rows)
    if (commit && current.to !== index) onMove(index, current.to)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
    if (to === null) return
    event.preventDefault()
    if (to >= 0 && to < count) onMove(index, to)
  }

  return <button type="button" className="icon-button drag-handle" disabled={disabled} aria-label={`Drag to reorder ${label}`} title="Drag to reorder (or use the arrow keys)"
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(event) => finish(event, true)} onPointerCancel={(event) => finish(event, false)} onKeyDown={onKeyDown}><GripVertical/></button>
}
