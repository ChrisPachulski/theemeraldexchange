import './FeedbackDots.css'

// Two dots under each suggestion card:
//   red on the left  — "don't suggest this again"  (per-user dislike + household veto)
//   green on the right — "show me more like this"  (per-user like → positive signal to AI)
//
// Mutually exclusive: setting one clears the other. Clicking the
// currently-set color clears the signal entirely. Click stops
// propagation so the card's onPick doesn't fire.

export type DotState = 'unset' | 'liked' | 'disliked'

type Props = {
  state: DotState
  onLike: () => void
  onDislike: () => void
  /** Card title for screen readers. */
  title: string
}

export function FeedbackDots({ state, onLike, onDislike, title }: Props) {
  const liked = state === 'liked'
  const disliked = state === 'disliked'

  return (
    <div className="feedback-dots" role="group" aria-label={`Feedback for ${title}`}>
      <button
        type="button"
        className={`feedback-dot feedback-dot--red${disliked ? ' feedback-dot--set' : ''}`}
        aria-pressed={disliked}
        aria-label={disliked ? `Undo: don't suggest ${title} again` : `Don't suggest ${title} again`}
        title={disliked ? 'Disliked — click to undo' : "Don't suggest again"}
        onClick={(e) => {
          e.stopPropagation()
          onDislike()
        }}
      />
      <button
        type="button"
        className={`feedback-dot feedback-dot--green${liked ? ' feedback-dot--set' : ''}`}
        aria-pressed={liked}
        aria-label={liked ? `Undo: liked ${title}` : `Show me more like ${title}`}
        title={liked ? 'Liked — click to undo' : 'Show me more like this'}
        onClick={(e) => {
          e.stopPropagation()
          onLike()
        }}
      />
    </div>
  )
}
