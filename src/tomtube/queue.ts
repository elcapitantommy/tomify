// The play-next queue and recently watched list, as plain functions over immutable state, so the
// player engine and the screens share one set of rules.
import type { TomTubeVideo } from './api'

export interface QueueState { items: TomTubeVideo[]; index: number }

export const emptyQueue: QueueState = { items: [], index: -1 }

export function current(state: QueueState): TomTubeVideo | null {
  return state.items[state.index] ?? null
}

export function upcoming(state: QueueState): TomTubeVideo[] {
  return state.items.slice(state.index + 1)
}

// Play this video now: it becomes current, and what was queued after the old current stays next.
export function playNow(state: QueueState, video: TomTubeVideo): QueueState {
  if (state.index < 0) return { items: [video], index: 0 }
  const items = [...state.items.slice(0, state.index + 1), video, ...state.items.slice(state.index + 1)]
  return { items, index: state.index + 1 }
}

export function playNext(state: QueueState, video: TomTubeVideo): QueueState {
  if (state.index < 0) return { items: [video], index: 0 }
  const items = [...state.items]
  items.splice(state.index + 1, 0, video)
  return { items, index: state.index }
}

export function addToQueue(state: QueueState, video: TomTubeVideo): QueueState {
  if (state.index < 0) return { items: [video], index: 0 }
  return { items: [...state.items, video], index: state.index }
}

export function removeAt(state: QueueState, position: number): QueueState {
  if (position < 0 || position >= state.items.length || position === state.index) return state
  const items = state.items.filter((_, index) => index !== position)
  return { items, index: position < state.index ? state.index - 1 : state.index }
}

export function move(state: QueueState, from: number, to: number): QueueState {
  if (from === to || from < 0 || to < 0 || from >= state.items.length || to >= state.items.length) return state
  const items = [...state.items]
  const [item] = items.splice(from, 1)
  items.splice(to, 0, item)
  let index = state.index
  if (from === state.index) index = to
  else if (from < state.index && to >= state.index) index -= 1
  else if (from > state.index && to <= state.index) index += 1
  return { items, index }
}

export function next(state: QueueState): QueueState | null {
  return state.index + 1 < state.items.length ? { ...state, index: state.index + 1 } : null
}

export function previous(state: QueueState): QueueState | null {
  return state.index > 0 ? { ...state, index: state.index - 1 } : null
}

export function jumpTo(state: QueueState, position: number): QueueState {
  return position >= 0 && position < state.items.length ? { ...state, index: position } : state
}

export function clearUpcoming(state: QueueState): QueueState {
  return state.index < 0 ? state : { items: state.items.slice(0, state.index + 1), index: state.index }
}

export interface HistoryEntry extends TomTubeVideo { watchedAt: number; position: number }

export const HISTORY_LIMIT = 100

// Most recent first, one entry per video.
export function recordHistory(history: HistoryEntry[], video: TomTubeVideo, now = Date.now(), position = 0): HistoryEntry[] {
  const entry: HistoryEntry = { id: video.id, title: video.title, channel: video.channel, duration: video.duration, viewCount: video.viewCount ?? null, watchedAt: now, position }
  return [entry, ...history.filter((item) => item.id !== video.id)].slice(0, HISTORY_LIMIT)
}

export function updatePosition(history: HistoryEntry[], id: string, position: number): HistoryEntry[] {
  const found = history.find((item) => item.id === id)
  if (!found || Math.abs(found.position - position) < 1) return history
  return history.map((item) => (item.id === id ? { ...item, position } : item))
}

// Where to start a video again: where it was left, unless that was near either end.
export function resumePosition(entry: HistoryEntry | undefined, duration: number | null) {
  if (!entry || entry.position < 30) return 0
  if (duration && entry.position > duration - 30) return 0
  return entry.position
}
