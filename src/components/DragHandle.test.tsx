import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DragHandle } from './DragHandle'

function renderList(onMove: (from: number, to: number) => void) {
  render(<ol>{['Alpha', 'Bravo', 'Charlie'].map((title, index) => <li key={title}>{title}<DragHandle index={index} count={3} label={title} onMove={onMove}/></li>)}</ol>)
  document.querySelectorAll('li').forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 50, height: 50, bottom: index * 50 + 50, left: 0, right: 100, width: 100, x: 0, y: index * 50, toJSON: () => ({}) }) })
}

describe('DragHandle', () => {
  it('moves a row to where it is dropped and marks the gap while dragging', () => {
    const onMove = vi.fn()
    renderList(onMove)
    const handle = screen.getByRole('button', { name: 'Drag to reorder Alpha' })
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientY: 20 })
    expect(document.querySelectorAll('li')[0]).toHaveClass('drag-source')
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 140 })
    expect(document.querySelectorAll('li')[2]).toHaveClass('drop-below')
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 140 })
    expect(onMove).toHaveBeenCalledWith(0, 2)
    expect(document.querySelector('.drag-source, .drop-below')).toBeNull()
  })

  it('does nothing when dropped where it started or cancelled', () => {
    const onMove = vi.fn()
    renderList(onMove)
    const handle = screen.getByRole('button', { name: 'Drag to reorder Bravo' })
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientY: 70 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 80 })
    fireEvent.pointerUp(handle, { pointerId: 2, clientY: 80 })
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientY: 70 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientY: 0 })
    fireEvent.pointerCancel(handle, { pointerId: 3 })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('moves with the arrow keys', () => {
    const onMove = vi.fn()
    renderList(onMove)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Bravo' }), { key: 'ArrowUp' })
    expect(onMove).toHaveBeenCalledWith(1, 0)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Drag to reorder Charlie' }), { key: 'ArrowDown' })
    expect(onMove).toHaveBeenCalledTimes(1)
  })
})
