// Patchy mobile data drops streams mid-track. Instead of giving up on the first
// network error, the player reloads the stream where it stopped, backing off between tries.
export const RETRY_DELAYS_MS = [1000, 3000, 6000, 10000]
// A stream that sits buffering this long while it should be playing is treated
// as dead (the connection hung without the browser reporting an error).
export const STALL_TIMEOUT_MS = 15000
// An adaptive (HLS) stream that hasn't started this long after play is switched to the original file.
export const ADAPTIVE_START_TIMEOUT_MS = 8000
