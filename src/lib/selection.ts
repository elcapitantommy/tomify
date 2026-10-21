// Ticking songs in a list. Shift-click (or shift-tap) ticks every song between the last one ticked and this one.
export function toggleSelection(selected: ReadonlySet<number>, index: number, anchor: number | null, range: boolean): Set<number> {
  const next = new Set(selected)
  if (range && anchor !== null && anchor !== index) {
    const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
    // The range takes the state the anchor song has, so shift-click can tick or untick a run of songs.
    const tick = selected.has(anchor)
    for (let position = from; position <= to; position += 1) {
      if (tick) next.add(position)
      else next.delete(position)
    }
    return next
  }
  if (next.has(index)) next.delete(index)
  else next.add(index)
  return next
}

// The ticked items, in list order.
export function selectedItems<T>(items: readonly T[], selected: ReadonlySet<number>): T[] {
  return items.filter((_, index) => selected.has(index))
}
