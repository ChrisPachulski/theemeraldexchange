// @vitest-environment jsdom
//
// The shared resume-or-start-over prompt. Pins the formatted offset, the
// role="group" labelling, and that each button fires its callback. The
// markup-identity-with-MediaPlayer guarantee is proven by the MediaPlayer DOM
// suite (which still renders this exact component); here we cover the
// component in isolation.

import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResumePrompt } from './ResumePrompt'

afterEach(cleanup)

describe('ResumePrompt', () => {
  it('renders the formatted resume time and the start-over choice in a labelled group', () => {
    render(<ResumePrompt resumeSecs={2036} onResume={() => {}} onStartOver={() => {}} />)

    // 2036s = 33:56 via formatPlaybackTime.
    expect(screen.getByRole('button', { name: 'Resume from 33:56' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start from beginning' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Resume playback' })).toBeInTheDocument()
  })

  it('fires onResume when the resume button is clicked', () => {
    const onResume = vi.fn()
    const onStartOver = vi.fn()
    render(<ResumePrompt resumeSecs={2036} onResume={onResume} onStartOver={onStartOver} />)

    fireEvent.click(screen.getByRole('button', { name: 'Resume from 33:56' }))

    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onStartOver).not.toHaveBeenCalled()
  })

  it('fires onStartOver when the start-over button is clicked', () => {
    const onResume = vi.fn()
    const onStartOver = vi.fn()
    render(<ResumePrompt resumeSecs={2036} onResume={onResume} onStartOver={onStartOver} />)

    fireEvent.click(screen.getByRole('button', { name: 'Start from beginning' }))

    expect(onStartOver).toHaveBeenCalledTimes(1)
    expect(onResume).not.toHaveBeenCalled()
  })
})
