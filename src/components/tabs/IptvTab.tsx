import LiveTab from './LiveTab'

// The Live tab is live TV only: the EPG guide with a Guide/Channels toggle
// in the footer. The old content-type subnav (Channels/Movies/Series) was
// removed — its "Channels" duplicated the footer toggle, and the on-demand
// VOD/Series sections are no longer surfaced here (removed for good in
// commits 54ceaf3/3558e28 after sitting orphaned for 3+ weeks).
export default function IptvTab() {
  return (
    <div className="iptv-shell">
      <LiveTab />
    </div>
  )
}
