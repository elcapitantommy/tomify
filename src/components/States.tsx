import { AlertCircle, RefreshCw, WifiOff } from 'lucide-react'

export function SkeletonGrid({ rows = 6 }: { rows?: number }) { return <div className="card-grid" aria-label="Loading"><span className="sr-only">Loading</span>{Array.from({ length: rows }, (_, i) => <div className="media-card skeleton-card" key={i}><div className="skeleton square"/><div className="skeleton line"/><div className="skeleton short"/></div>)}</div> }
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) { return <div className="state-card"><WifiOff /><h2>We can’t reach your music</h2><p>{message}</p>{retry && <button className="button secondary" onClick={retry}><RefreshCw size={16}/>Try again</button>}</div> }
export function EmptyState({ title, message }: { title: string; message: string }) { return <div className="state-card"><AlertCircle /><h2>{title}</h2><p>{message}</p></div> }
