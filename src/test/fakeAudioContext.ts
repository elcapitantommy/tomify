// A stand-in for Web Audio, which jsdom doesn't have: records nodes and connections.
export class FakeAudioNode {
  readonly connections: unknown[] = []
  connect(target: unknown) { this.connections.push(target); return target }
}
export class FakeParam { value = 0 }
export class FakeBiquad extends FakeAudioNode { type = 'peaking'; frequency = new FakeParam(); Q = new FakeParam(); gain = new FakeParam() }
export class FakeGain extends FakeAudioNode { gain = new FakeParam() }
export class FakeMediaSource extends FakeAudioNode { constructor(readonly element: HTMLMediaElement) { super() } }

export class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  state: 'suspended' | 'running' = 'suspended'
  readonly destination = new FakeAudioNode()
  readonly filters: FakeBiquad[] = []
  readonly gains: FakeGain[] = []
  readonly sources: FakeMediaSource[] = []
  resumes = 0
  constructor() { FakeAudioContext.instances.push(this) }
  createBiquadFilter() { const node = new FakeBiquad(); this.filters.push(node); return node }
  createGain() { const node = new FakeGain(); node.gain.value = 1; this.gains.push(node); return node }
  createMediaElementSource(element: HTMLMediaElement) { const node = new FakeMediaSource(element); this.sources.push(node); return node }
  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve() }
}
