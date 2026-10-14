const artworkProviderPriority = { apple: 1, spotify: 2, 'cover-art-archive': 3, youtube: 4 }

export function artworkQuality(width, height) {
  const w = Number(width) || 0
  const h = Number(height) || 0
  const minimum = Math.min(w, h)
  const square = w > 0 && h > 0 && Math.abs(w / h - 1) <= 0.08
  if (square && minimum >= 1000) return { tier: 'high', square, minimum }
  if (square && minimum >= 600) return { tier: 'preferred', square, minimum }
  return { tier: 'fallback', square, minimum }
}

export function rankArtworkCandidates(candidates) {
  const deduplicated = []
  const seen = new Set()
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate?.id || !candidate?.url || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    const quality = artworkQuality(candidate.width, candidate.height)
    if (quality.minimum > 0 && quality.minimum < 200) continue
    deduplicated.push({ ...candidate, quality: quality.tier, square: quality.square, minimumDimension: quality.minimum })
  }
  const tier = { high: 0, preferred: 1, fallback: 2 }
  return deduplicated.sort((left, right) => {
    const qualityDifference = tier[left.quality] - tier[right.quality]
    if (qualityDifference) return qualityDifference
    const providerDifference = (artworkProviderPriority[left.provider] || 99) - (artworkProviderPriority[right.provider] || 99)
    if (providerDifference) return providerDifference
    const confidenceDifference = Number(right.confidence || 0) - Number(left.confidence || 0)
    if (confidenceDifference) return confidenceDifference
    return Number(right.minimumDimension || 0) - Number(left.minimumDimension || 0)
  })
}

export function appleArtworkUrl(url, size = 1200) {
  const value = String(url || '').replace(/^http:/, 'https:')
  return value.replace(/\d+x\d+(?=[^/]*\.(?:jpg|jpeg|png|webp)(?:\?|$))/i, `${size}x${size}`)
}

export const recoveryArtworkWorkerSource = `const artworkProviderPriority = ${JSON.stringify(artworkProviderPriority)}\n\n${[artworkQuality, rankArtworkCandidates, appleArtworkUrl].map((fn) => fn.toString()).join('\n\n')}`
