// Drag to reorder: the pointer's position among the rows' vertical midpoints says where the dragged row
// would be inserted; `dropIndex` turns that into the row's new index once it is taken out of the list.
export function insertionPoint(midpoints: number[], y: number) {
  const index = midpoints.findIndex((mid) => y < mid)
  return index < 0 ? midpoints.length : index
}

export function dropIndex(from: number, insertion: number) {
  return insertion > from ? insertion - 1 : insertion
}

export function moveItem<T>(items: T[], from: number, to: number) {
  if (from === to || from < 0 || from >= items.length) return items
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}
