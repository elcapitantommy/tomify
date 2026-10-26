import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearPlaybackLog, logPlayback } from '../lib/playbackLog'
import { PlaybackLog } from './PlaybackLog'

describe('PlaybackLog', () => {
  beforeEach(() => clearPlaybackLog())

  it('shows what happened and can be cleared', () => {
    logPlayback('Ignored play', 'an audio device had just come or gone')
    render(<PlaybackLog/>)
    expect(screen.getByLabelText('Playback log').textContent).toContain('Ignored play (an audio device had just come or gone)')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByLabelText('Playback log').textContent).toBe('Nothing yet.')
  })
})
