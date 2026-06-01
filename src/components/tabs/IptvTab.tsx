import LiveTab from './LiveTab'

// The Live tab is live TV only: the EPG guide with a Guide/Channels toggle
// in the footer. The old content-type subnav (Channels/Movies/Series) was
// removed — its "Channels" duplicated the footer toggle, and the on-demand
// VOD/Series sections (VodTab, IptvSeriesTab) are no longer surfaced here.
// Those components remain in the codebase if they need a home later.
export default function IptvTab() {
  return (
    <div className="iptv-shell">
      <LiveTab />
    </div>
  )
}
