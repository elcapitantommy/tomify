export type QualityTier = 'lossless' | 'transparent-lossy' | 'lossy' | 'unknown'
export type QualityTarget = 'lossless' | 'transparent-lossy' | 'lossy'

export interface QualityProbe {
  codec?: string | null
  container?: string | null
  bitrate?: number | null
  vbrPreset?: string | null
  tags?: Record<string, unknown> | null
}

export interface QualityRule {
  family: string
  label: string
  codecs: string[]
  lossless?: boolean
  minKbps?: number
  v0?: boolean
  prefix?: string
}

export interface QualityClassification {
  tier: QualityTier
  codec: string | null
  kbps: number | null
  reason: string
}

export function qualityTiers(): QualityTier[]
export function qualityTargets(): QualityTarget[]
export function defaultQualityTarget(): QualityTarget
export function qualityRules(): QualityRule[]
export function qualityRuleFor(value: string | null | undefined): QualityRule | null
export function qualityLooksV0(quality: QualityProbe | null | undefined): boolean
export function qualityKbps(quality: QualityProbe | null | undefined): number | null
export function classifyQuality(quality: QualityProbe | null | undefined): QualityClassification
export function qualityMeetsTarget(tier: QualityTier, target: QualityTarget | string | null | undefined): boolean
export function qualityTierDescription(tier: QualityTier | string): string
