import { fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { useSearchParamState } from './useSearchParamState'

function Tabs() {
  const [tab, setTab] = useSearchParamState('type', 'album', ['album', 'all'] as const)
  const location = useLocation()
  return <><p>tab:{tab}</p><p>url:{location.search}</p><button onClick={() => setTab('all')}>All</button><button onClick={() => setTab('album')}>Albums</button><Link to="/albums/1">Open</Link></>
}
function Detail() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>Back</button> }

describe('useSearchParamState', () => {
  it('keeps the chosen tab in the URL so Back returns to it', () => {
    render(<MemoryRouter initialEntries={['/albums']}><Routes><Route path="/albums" element={<Tabs/>}/><Route path="/albums/:id" element={<Detail/>}/></Routes></MemoryRouter>)
    expect(screen.getByText('tab:album')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('url:?type=all')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('tab:all')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Albums' }))
    expect(screen.getByText('url:')).toBeInTheDocument()
  })

  it('ignores unknown values in the URL', () => {
    render(<MemoryRouter initialEntries={['/albums?type=bogus']}><Routes><Route path="/albums" element={<Tabs/>}/></Routes></MemoryRouter>)
    expect(screen.getByText('tab:album')).toBeInTheDocument()
  })
})
