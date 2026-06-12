import { formatPlaybackTime } from './playbackSession'

type Props = {
  /** Saved watch position, in seconds. Shown as the formatted "Resume from". */
  resumeSecs: number
  onResume: () => void
  onStartOver: () => void
}

/**
 * Resume-or-start-over prompt shown before a resumable title plays. Shared by
 * every resumable surface (the local-media MediaPlayer and the IPTV VOD/Series
 * tabs) so the wording and markup can't drift apart. The DOM here is identical
 * to the block MediaPlayer used to inline — the MediaPlayer DOM tests are the
 * regression proof.
 */
export function ResumePrompt({ resumeSecs, onResume, onStartOver }: Props) {
  return (
    <div className="iptv-tab__status media-resume" role="group" aria-label="Resume playback">
      <p>You were partway through this title.</p>
      <div className="media-resume__choices">
        <button className="iptv-tab__retry" type="button" onClick={onResume}>
          Resume from {formatPlaybackTime(resumeSecs)}
        </button>
        <button className="iptv-tab__retry" type="button" onClick={onStartOver}>
          Start from beginning
        </button>
      </div>
    </div>
  )
}
