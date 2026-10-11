export function formatDuration(seconds = 0) { if (!Number.isFinite(seconds)) return '0:00'; const whole = Math.max(0, Math.floor(seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}` }
export function formatHours(seconds = 0) { const minutes = Math.round(seconds / 60); return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min` }
export function initials(value: string) { return value.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase() }
