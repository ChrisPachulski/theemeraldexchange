import { useState } from 'react'
import LiveTab from './LiveTab'
import VodTab from './VodTab'
import IptvSeriesTab from './IptvSeriesTab'
import { ConnectionsWidget } from '../iptv/ConnectionsWidget'

type Sub = 'channels' | 'movies' | 'series'

const SUBS: Array<{ key: Sub; label: string }> = [
  { key: 'channels', label: 'Channels' },
  { key: 'movies', label: 'Movies' },
  { key: 'series', label: 'Series' },
]

export default function IptvTab() {
  const [sub, setSub] = useState<Sub>('channels')

  return (
    <div className="iptv-shell">
      <nav className="iptv-shell__subnav" role="tablist" aria-label="IPTV sections">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={sub === s.key}
            className={`iptv-shell__subtab ${sub === s.key ? 'iptv-shell__subtab--active' : ''}`}
            onClick={() => setSub(s.key)}
          >
            {s.label}
          </button>
        ))}
        <ConnectionsWidget />
      </nav>
      {sub === 'channels' && <LiveTab />}
      {sub === 'movies' && <VodTab />}
      {sub === 'series' && <IptvSeriesTab />}
    </div>
  )
}
