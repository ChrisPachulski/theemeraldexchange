import { describe, expect, it, vi } from 'vitest'
import { createModalKeydownHandler, type FocusableLike } from './useModalA11y'

// The vitest environment is node (no DOM), so these drive the extracted
// keydown contract with plain focusable fakes — the same logic the hook
// attaches to the real container element.

type Fake = FocusableLike & { name: string }

function fake(name: string): Fake {
  return { name, focus: vi.fn() }
}

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn() }
}

function harness(items: Fake[], active?: () => unknown) {
  const container = fake('container')
  const onClose = vi.fn()
  let activeEl: unknown = null
  const handler = createModalKeydownHandler<Fake>({
    container,
    focusables: () => items,
    activeElement: active ?? (() => activeEl),
    onClose,
  })
  return { container, onClose, handler, setActive: (el: unknown) => { activeEl = el } }
}

describe('createModalKeydownHandler', () => {
  it('Escape closes the modal and swallows the event', () => {
    const h = harness([fake('btn')])
    const e = keyEvent('Escape')

    h.handler(e)

    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('non-Tab, non-Escape keys pass through untouched', () => {
    const h = harness([fake('btn')])
    const e = keyEvent('Enter')

    h.handler(e)

    expect(h.onClose).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('Tab with nothing focusable keeps focus pinned to the container', () => {
    const h = harness([])
    const e = keyEvent('Tab')

    h.handler(e)

    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(h.container.focus).toHaveBeenCalledTimes(1)
  })

  it('Tab on the last focusable wraps to the first (trap forward)', () => {
    const first = fake('first')
    const last = fake('last')
    const h = harness([first, last])
    h.setActive(last)
    const e = keyEvent('Tab')

    h.handler(e)

    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(first.focus).toHaveBeenCalledTimes(1)
  })

  it('Tab in the middle of the cycle is left to the browser', () => {
    const first = fake('first')
    const last = fake('last')
    const h = harness([first, last])
    h.setActive(first)
    const e = keyEvent('Tab')

    h.handler(e)

    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('Shift+Tab on the first focusable wraps to the last (trap backward)', () => {
    const first = fake('first')
    const last = fake('last')
    const h = harness([first, last])
    h.setActive(first)
    const e = keyEvent('Tab', true)

    h.handler(e)

    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(last.focus).toHaveBeenCalledTimes(1)
  })

  it('Shift+Tab while the container itself holds focus wraps to the last', () => {
    const first = fake('first')
    const last = fake('last')
    const h = harness([first, last])
    const e = keyEvent('Tab', true)
    h.setActive(h.container)

    h.handler(e)

    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(last.focus).toHaveBeenCalledTimes(1)
  })
})
