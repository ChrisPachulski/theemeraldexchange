import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  authModeFromUser,
  createInvite,
  listInvites,
  listMembers,
  revokeInvite,
  revokeMember,
  type CreatedInvite,
  type InviteView,
  type MemberView,
} from '../../lib/auth'
import { ApiError } from '../../lib/api/errors'
import './InvitesPanel.css'

// Owner-only allowlist management: issue single-use invite codes (shown
// exactly once), see/revoke outstanding invites, and see/revoke members.
// Lives inside UserMenu as a <details> disclosure beside DevicesPanel,
// gated by the caller to admins only. All calls are credentialed and the
// server enforces requireAdmin independently — this UI is convenience,
// not the security boundary.

const INVITES_KEY = ['admin', 'invites'] as const
const MEMBERS_KEY = ['admin', 'members'] as const

function fmtDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function providerLabel(mode: MemberView['auth_mode']): string {
  switch (mode) {
    case 'apple':
      return 'Apple'
    case 'plex':
      return 'Plex'
    default:
      return mode
  }
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback
}

export function InvitesPanel() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [justCreated, setJustCreated] = useState<CreatedInvite | null>(null)
  const [copied, setCopied] = useState(false)
  const [label, setLabel] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(14)

  const invitesQ = useQuery({
    queryKey: INVITES_KEY,
    queryFn: listInvites,
    staleTime: 10_000,
  })
  const membersQ = useQuery({
    queryKey: MEMBERS_KEY,
    queryFn: listMembers,
    staleTime: 10_000,
  })

  const create = useMutation({
    mutationFn: () =>
      createInvite({
        label: label.trim() || undefined,
        expiresInDays,
        maxUses: 1,
      }),
    onSuccess: (invite) => {
      setJustCreated(invite)
      setCopied(false)
      setLabel('')
      setError(null)
      void qc.invalidateQueries({ queryKey: INVITES_KEY })
    },
    onError: (e) => setError(errMessage(e, 'Could not create an invite. Try again.')),
  })

  const revokeInv = useMutation({
    mutationFn: (prefix: string) => revokeInvite(prefix),
    onSuccess: () => qc.invalidateQueries({ queryKey: INVITES_KEY }),
    onError: (e) => setError(errMessage(e, 'Could not revoke that invite. Try again.')),
  })

  const revokeMem = useMutation({
    mutationFn: (sub: string) => revokeMember(sub),
    onSuccess: () => qc.invalidateQueries({ queryKey: MEMBERS_KEY }),
    onError: (e) => setError(errMessage(e, 'Could not revoke that member. Try again.')),
  })

  const invites: InviteView[] = invitesQ.data ?? []
  const members: MemberView[] = membersQ.data ?? []
  const activeMembers = members.filter((m) => !m.revoked_at)
  const summary =
    activeMembers.length === 0
      ? 'No members yet'
      : `${activeMembers.length} member${activeMembers.length === 1 ? '' : 's'}`

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      // Clipboard blocked (insecure context / permissions) — the code is
      // still visible for manual copy; just don't flip the label.
      setCopied(false)
    }
  }

  return (
    <details className="invites-panel user-menu__disclosure">
      <summary className="user-menu__disclosure-summary">
        <span className="user-menu__eyebrow">Invites &amp; members</span>
        <span className="user-menu__disclosure-status">{summary}</span>
      </summary>

      <p className="invites-panel__hint">
        Generate an invite code, then send it to the new household member. They
        paste it once on the sign-in page; after that their Apple or Plex login
        is remembered. Codes are single-use and expire.
      </p>

      {/* Create */}
      <div className="invites-panel__create">
        <div className="invites-panel__create-row">
          <input
            className="invites-panel__input"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (e.g. Mom's iPad)"
            maxLength={120}
          />
          <label className="invites-panel__expiry">
            Expires
            <select
              className="invites-panel__select"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          className="invites-panel__btn invites-panel__btn--primary"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create invite'}
        </button>
      </div>

      {/* One-time code reveal */}
      {justCreated && (
        <div className="invites-panel__reveal" role="status">
          <p className="invites-panel__reveal-title">
            Copy this code now — it won&apos;t be shown again.
          </p>
          <div className="invites-panel__reveal-row">
            <code className="invites-panel__code">{justCreated.code}</code>
            <button
              type="button"
              className="invites-panel__btn"
              onClick={() => void copyCode(justCreated.code)}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            className="invites-panel__btn invites-panel__btn--ghost"
            onClick={() => {
              setJustCreated(null)
              setCopied(false)
            }}
          >
            Done
          </button>
        </div>
      )}

      {/* Outstanding invites */}
      <section className="invites-panel__section" aria-label="Outstanding invites">
        <p className="invites-panel__section-title">Outstanding invites</p>
        {invitesQ.isLoading && <p className="invites-panel__loading">Loading…</p>}
        {!invitesQ.isLoading && invites.length === 0 && (
          <p className="invites-panel__empty">No invites issued.</p>
        )}
        {invites.length > 0 && (
          <ul className="invites-panel__list">
            {invites.map((inv) => (
              <li key={inv.code_hash_prefix} className="invites-panel__item">
                <div className="invites-panel__item-main">
                  <span className="invites-panel__item-name">
                    {inv.label || <code>{inv.code_hash_prefix}…</code>}
                  </span>
                  <span className="invites-panel__item-meta">
                    <span className={`invites-panel__status invites-panel__status--${inv.status}`}>
                      {inv.status}
                    </span>
                    {' · '}
                    {inv.used_count}/{inv.max_uses} used · expires {fmtDate(inv.expires_at)}
                  </span>
                </div>
                {inv.status === 'active' && (
                  <button
                    type="button"
                    className="invites-panel__btn invites-panel__btn--danger"
                    onClick={() => revokeInv.mutate(inv.code_hash_prefix)}
                    disabled={revokeInv.isPending}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Members */}
      <section className="invites-panel__section" aria-label="Members">
        <p className="invites-panel__section-title">Members</p>
        {membersQ.isLoading && <p className="invites-panel__loading">Loading…</p>}
        {!membersQ.isLoading && members.length === 0 && (
          <p className="invites-panel__empty">No members yet.</p>
        )}
        {members.length > 0 && (
          <ul className="invites-panel__list">
            {members.map((m) => (
              <li key={m.sub} className="invites-panel__item">
                <div className="invites-panel__item-main">
                  <span className="invites-panel__item-name">
                    {m.display_name || m.sub}
                    {m.is_admin && <span className="invites-panel__badge">owner</span>}
                  </span>
                  <span className="invites-panel__item-meta">
                    {providerLabel(authModeFromUser({ sub: m.sub, auth_mode: m.auth_mode }))}
                    {' · joined '}
                    {fmtDate(m.joined_at)}
                    {m.revoked_at && ' · revoked'}
                  </span>
                </div>
                {!m.revoked_at && !m.is_admin && (
                  <button
                    type="button"
                    className="invites-panel__btn invites-panel__btn--danger"
                    onClick={() => revokeMem.mutate(m.sub)}
                    disabled={revokeMem.isPending}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p className="invites-panel__error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
