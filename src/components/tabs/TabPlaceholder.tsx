import { useConfirm } from '../confirm/useConfirm'
import './TabPlaceholder.css'

type Props = {
  title: string
  copy: string
}

export function TabPlaceholder({ title, copy }: Props) {
  const confirm = useConfirm()

  // Phase 2 wiring proof: clicking the title fires the ConfirmModal so we can
  // verify it works in the browser before any real destructive actions exist.
  // Removed in Phase 3+ when real flows replace this content.
  const probe = () => {
    confirm({
      title: `Probe the ${title} confirm flow`,
      body: 'This is a Phase 2 sanity probe so the ConfirmModal can be exercised before real destructive actions are wired up. Cancel returns; confirm logs.',
      confirmLabel: 'Confirm',
      onConfirm: () => {
        // Phase 3+ replaces this with real API calls.
        console.log(`[probe] ${title} confirmed`)
      },
    })
  }

  return (
    <section className="tab-placeholder">
      <button type="button" className="tab-placeholder__title" onClick={probe}>
        {title}
      </button>
      <p className="tab-placeholder__copy">{copy}</p>
      <p className="tab-placeholder__hint">Tap the title to probe the confirm modal.</p>
    </section>
  )
}
