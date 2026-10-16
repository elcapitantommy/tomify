// Quality tiers shared by the Worker (scripts/quality-worker.mjs), the recovery agent
// (recovery-agent/metadata.mjs) and the frontend (src/lib/recovery.ts). Plain functions only:
// the Worker build embeds them with Function.prototype.toString, so nothing here may refer
// to module-level values.

/** Tiers from best to worst. `unknown` means there was not enough data to judge. */
export function qualityTiers() {
  return ['lossless', 'transparent-lossy', 'lossy', 'unknown']
}

/** Targets an administrator can choose: the lowest tier that counts as good enough. */
export function qualityTargets() {
  return ['lossless', 'transparent-lossy', 'lossy']
}

export function defaultQualityTarget() {
  return 'transparent-lossy'
}

// One row per codec family. `codecs` match ffprobe codec_name (and file extensions, for a
// container-only probe). `minKbps` is the average bitrate at which the codec counts as transparent.
// MP3 counts from 240 kbps: LAME V0 is VBR and averages roughly 240-260 kbps, so a 243 kbps V0
// rip is transparent even though it is under the 245 kbps CBR line.
export function qualityRules() {
  return [
    { family: 'flac', label: 'FLAC', lossless: true, codecs: ['flac'] },
    { family: 'alac', label: 'ALAC', lossless: true, codecs: ['alac'] },
    { family: 'wav', label: 'WAV', lossless: true, codecs: ['wav', 'pcm'], prefix: 'pcm_' },
    { family: 'aiff', label: 'AIFF', lossless: true, codecs: ['aiff', 'aif', 'aifc'] },
    { family: 'other-lossless', label: 'Lossless', lossless: true, codecs: ['ape', 'wavpack', 'wv', 'tta', 'truehd', 'mlp'] },
    { family: 'opus', label: 'Opus', minKbps: 128, codecs: ['opus'] },
    { family: 'aac', label: 'AAC', minKbps: 192, codecs: ['aac', 'aac_latm', 'm4a'] },
    { family: 'mp3', label: 'MP3', minKbps: 240, v0: true, codecs: ['mp3', 'mp3float'] },
  ]
}

export function qualityRuleFor(value) {
  const name = String(value || '').trim().toLowerCase()
  if (!name) return null
  return qualityRules().find((rule) => rule.codecs.includes(name) || (rule.prefix && name.startsWith(rule.prefix))) || null
}

/** Average bitrate in kbps. ffprobe reports bits per second; small values are taken to be kbps already. */
export function qualityKbps(quality) {
  const bitrate = Number(quality?.bitrate)
  if (!Number.isFinite(bitrate) || bitrate <= 0) return null
  return bitrate >= 4000 ? bitrate / 1000 : bitrate
}

// LAME writes its preset into encoder settings tags on some rips, e.g. "-V 0" or "V0".
export function qualityLooksV0(quality) {
  if (quality?.vbrPreset && /^v ?0$/i.test(String(quality.vbrPreset).trim())) return true
  const tags = quality?.tags && typeof quality.tags === 'object' ? quality.tags : {}
  return Object.entries(tags).some(([key, value]) => /encod|comment/i.test(key) && /(^|[\s-])V ?0(\b|$)/.test(String(value)))
}

/**
 * Classifies a probe-like object ({ codec, container, bitrate, tags }) into a tier.
 * Returns { tier, codec, kbps, reason }.
 */
export function classifyQuality(quality) {
  const container = String(quality?.container || '').split(',')[0]
  const rule = qualityRuleFor(quality?.codec) || (quality?.codec ? null : qualityRuleFor(container))
  const kbps = qualityKbps(quality)
  const codec = rule ? rule.label : quality?.codec ? String(quality.codec).toUpperCase() : null
  if (rule?.lossless) return { tier: 'lossless', codec, kbps, reason: `${rule.label} is lossless` }
  if (rule && qualityLooksV0(quality) && rule.v0) return { tier: 'transparent-lossy', codec, kbps, reason: 'MP3 V0 is transparent' }
  if (kbps == null) return { tier: 'unknown', codec, kbps, reason: codec ? `${codec} with no measured bitrate` : 'No usable quality data' }
  if (rule && kbps >= rule.minKbps) return { tier: 'transparent-lossy', codec, kbps, reason: `${rule.label} at ${Math.round(kbps)} kbps is transparent (from ${rule.minKbps} kbps)` }
  if (!codec) return { tier: 'unknown', codec, kbps, reason: 'No codec reported' }
  return { tier: 'lossy', codec, kbps, reason: rule ? `${rule.label} below ${rule.minKbps} kbps` : `${codec} is lossy` }
}

/** True when the tier is at least as good as the target. `unknown` never meets a target. */
export function qualityMeetsTarget(tier, target) {
  const tiers = qualityTiers()
  const wanted = qualityTargets().includes(target) ? target : defaultQualityTarget()
  return tier !== 'unknown' && tiers.indexOf(tier) !== -1 && tiers.indexOf(tier) <= tiers.indexOf(wanted)
}

/** Short plain-English explanation of a tier, for labels and tags. */
export function qualityTierDescription(tier) {
  return {
    lossless: 'Lossless: identical to the CD or master',
    'transparent-lossy': 'Transparent: lossy, but sounds the same as lossless',
    lossy: 'Lossy: compression may be audible, worth upgrading',
    unknown: 'Unknown: not enough data to judge',
  }[tier] || 'Unknown: not enough data to judge'
}
