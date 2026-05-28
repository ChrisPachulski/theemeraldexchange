import { type ReactElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SourceToggle, type SourceMode } from './SourceToggle'

// Walk a React element tree (the value returned by calling the component
// as a function) and collect every <button> element so we can inspect
// its props — including the onClick handler the static-markup renderer
// would otherwise drop. The node env has no DOM, so this is how we
// exercise click behavior without @testing-library.
function collectButtons(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out)
    return out
  }
  if (!isValidElement(node)) return out
  if (node.type === 'button') out.push(node)
  const props = node.props as { children?: unknown }
  if (props.children !== undefined) collectButtons(props.children, out)
  return out
}

// The project's component tests render to static markup (vitest runs in
// the `node` environment — no jsdom, no @testing-library). We assert the
// rendered ARIA/labels from the HTML and exercise the onClick handler by
// invoking the prop directly, mirroring IptvPlayer.test.tsx.

describe('SourceToggle', () => {
  it('renders both tabs with their labels', () => {
    const html = renderToStaticMarkup(
      <SourceToggle mode="local" onChange={() => {}} />,
    )
    expect(html).toContain('Available locally')
    expect(html).toContain('Requestable')
    // Two role=tab buttons inside a role=tablist.
    expect(html).toContain('role="tablist"')
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2)
  })

  it('aria-selected tracks the mode prop (local)', () => {
    const html = renderToStaticMarkup(
      <SourceToggle mode="local" onChange={() => {}} />,
    )
    // The "Available locally" tab carries the active class + selected.
    expect(html).toContain('source-toggle__option--active')
    // Exactly one tab is selected.
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
    // The active marker precedes the "Available locally" label.
    const activeIdx = html.indexOf('source-toggle__option--active')
    const localIdx = html.indexOf('Available locally')
    const requestIdx = html.indexOf('Requestable')
    expect(activeIdx).toBeLessThan(localIdx)
    expect(activeIdx).toBeLessThan(requestIdx)
  })

  it('aria-selected tracks the mode prop (requestable)', () => {
    const html = renderToStaticMarkup(
      <SourceToggle mode="requestable" onChange={() => {}} />,
    )
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
    // The active marker now precedes "Requestable" but follows the
    // (inactive) "Available locally" label.
    const activeIdx = html.indexOf('source-toggle__option--active')
    const localIdx = html.indexOf('Available locally')
    const requestIdx = html.indexOf('Requestable')
    expect(activeIdx).toBeGreaterThan(localIdx)
    expect(activeIdx).toBeLessThan(requestIdx)
  })

  it('clicking the inactive tab fires onChange with the other mode', () => {
    const onChange = vi.fn<(next: SourceMode) => void>()
    // Call the component as a function to get its element tree, then pull
    // the two real <button> onClick handlers out and invoke them.
    const tree = SourceToggle({ mode: 'local', onChange })
    const buttons = collectButtons(tree)
    expect(buttons).toHaveLength(2)

    const handlerFor = (label: string) =>
      buttons.find((b) => {
        const html = renderToStaticMarkup(b)
        return html.includes(label)
      })?.props as { onClick?: () => void } | undefined

    handlerFor('Requestable')?.onClick?.()
    expect(onChange).toHaveBeenLastCalledWith('requestable')

    handlerFor('Available locally')?.onClick?.()
    expect(onChange).toHaveBeenLastCalledWith('local')
  })

  it('renders the local count when provided', () => {
    const html = renderToStaticMarkup(
      <SourceToggle mode="local" onChange={() => {}} localCount={12} />,
    )
    expect(html).toContain('source-toggle__count')
    expect(html).toContain('12')
  })
})
