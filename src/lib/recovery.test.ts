import { describe, expect, it } from 'vitest'
import { isTorrentSearchResult, looksLikeTorrentLink, qualityLabel, scoreRecoveryCandidate, torrentResultSummary, torrentTransferSummary } from './recovery'

describe('recovery candidate matching', () => {
  it('favours an official, duration-matched upload', () => {
    const wanted = { artist: 'Feeder', title: 'Sweet 16', duration: 214 }
    const official = scoreRecoveryCandidate(wanted, { title: 'Feeder - Sweet 16 (Official Audio)', channel: 'FeederVEVO', duration: 214 })
    const live = scoreRecoveryCandidate(wanted, { title: 'Feeder - Sweet 16 live at Reading', channel: 'Fan Uploads', duration: 260 })
    expect(official.official).toBe(true)
    expect(official.score).toBeGreaterThan(90)
    expect(live.score).toBeLessThan(official.score)
  })

  it('does not claim unknown quality before inspection', () => {
    expect(qualityLabel({})).toBe('Quality measured after import')
    expect(qualityLabel({ codec: 'aac', bitrate: 128_000, sampleRate: 44_100, channels: 2 })).toBe('AAC · 128 kbps · 44.1 kHz · 2 ch')
  })
})

describe('torrent links', () => {
  it('recognises magnet and http(s) links only', () => {
    expect(looksLikeTorrentLink(' magnet:?xt=urn:btih:abc&dn=Flood ')).toBe(true)
    expect(looksLikeTorrentLink('https://example.com/flood.torrent')).toBe(true)
    expect(looksLikeTorrentLink('magnet:?dn=Flood')).toBe(false)
    expect(looksLikeTorrentLink('Flood FLAC')).toBe(false)
  })

  it('summarises a torrent search result and tells it apart from a pasted link', () => {
    expect(torrentResultSummary({ seeds: 1, peers: 0, size: 1_500_000_000 })).toBe('1 seed · 0 peers · 1.5 GB')
    expect(torrentResultSummary({ seeds: 12 })).toBe('12 seeds')
    expect(torrentResultSummary({})).toBeNull()
    expect(isTorrentSearchResult({ backend: 'torrent', provenance: { raw: { providerId: 'qbittorrent-search' } } })).toBe(true)
    expect(isTorrentSearchResult({ backend: 'torrent', provenance: { raw: { providerId: 'torrent-link' } } })).toBe(false)
  })

  it('summarises live torrent figures and leaves out what qBittorrent does not know', () => {
    expect(torrentTransferSummary({ downloadSpeed: 950, seeds: 1, peers: 0, eta: 7200 })).toBe('950 B/s · 1 seed · 0 peers · 2 h 0 min left')
    expect(torrentTransferSummary({ seeds: 0, seedsInSwarm: 0, eta: null })).toBe('0 seeds')
    expect(torrentTransferSummary(null)).toBeNull()
  })
})
