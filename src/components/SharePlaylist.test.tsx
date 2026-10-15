import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SharePlaylist } from './SharePlaylist'

describe('SharePlaylist', () => {
  it('saves the accounts ticked in the Share with list', async () => {
    const save = vi.fn(async (users: string[]) => users)
    render(<SharePlaylist accounts={['anna', 'sam']} sharedWith={[]} save={save}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    fireEvent.click(screen.getByLabelText('anna'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('button', { name: 'Shared with 1' })).toBeInTheDocument()
    expect(save).toHaveBeenCalledWith(['anna'])
  })

  it('shows existing shares and why saving failed', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Only the playlist\'s owner can change who it is shared with.'))
    render(<SharePlaylist accounts={['anna', 'sam']} sharedWith={['sam']} save={save}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Shared with 1' }))
    expect(screen.getByLabelText('sam')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Only the playlist\'s owner')
  })

  it('explains where other accounts come from when there are none yet', () => {
    render(<SharePlaylist accounts={[]} sharedWith={[]} save={vi.fn()}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(screen.getByText(/once they have signed in to Tomify/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
