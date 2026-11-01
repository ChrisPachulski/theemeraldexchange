import { useState, type FormEvent } from 'react'
import { apiUrl } from '../../lib/api/base'
import { deniedMessage } from '../../lib/auth'
import './EmailSignIn.css'

// Email sign-in on our own page: address in, a 6-digit code mailed out, code
// in. The server sets the session cookie on success and we reload into the
// app, the same landing the redirect providers get. The guest never leaves
// the site for a hosted page.

type Step = 'closed' | 'email' | 'code'

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

function failureMessage(status: number, data: Record<string, unknown>): string {
  if (status === 429) return 'Too many tries. Wait a minute, then try again.'
  if (status === 403) return deniedMessage(data.reason)
  return deniedMessage(data.error)
}

export function EmailSignIn({
  inviteCode,
  disabled,
  idPrefix,
}: {
  inviteCode?: string
  disabled?: boolean
  idPrefix: string
}) {
  const [step, setStep] = useState<Step>('closed')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  const sendCode = async (again = false) => {
    setBusy(true)
    setError(null)
    try {
      const r = await post('/api/auth/workos/email/start', { email: email.trim() })
      if (r.status !== 200) {
        setError(failureMessage(r.status, r.data))
        return
      }
      setStep('code')
      setCode('')
      setResent(again)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await post('/api/auth/workos/email/verify', {
        email: email.trim(),
        code: code.trim(),
        ...(inviteCode ? { inviteCode } : {}),
      })
      if (r.status === 200) {
        window.location.assign('/')
        return
      }
      setError(failureMessage(r.status, r.data))
      setBusy(false)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    void (step === 'email' ? sendCode() : verify())
  }

  if (step === 'closed') {
    return (
      <button
        type="button"
        className="walkthrough__signin-button"
        onClick={() => setStep('email')}
        disabled={disabled}
      >
        Sign in with email
      </button>
    )
  }

  const emailId = `${idPrefix}-email`
  const codeId = `${idPrefix}-code`
  const errorId = `${idPrefix}-email-error`
  return (
    <form className="email-signin" onSubmit={submit} aria-label="Sign in with email" noValidate>
      {step === 'email' ? (
        <>
          <label className="email-signin__label" htmlFor={emailId}>
            Your email
          </label>
          <input
            id={emailId}
            className="email-signin__input"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={busy || disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <button
            type="submit"
            className="walkthrough__signin-button"
            disabled={busy || disabled || !email.trim()}
          >
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </>
      ) : (
        <>
          <label className="email-signin__label" htmlFor={codeId}>
            {resent ? 'New code sent to ' : 'Code sent to '}
            <span className="email-signin__address">{email.trim()}</span>
          </label>
          <input
            id={codeId}
            className="email-signin__input email-signin__input--code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="6-digit code"
            disabled={busy || disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          <button
            type="submit"
            className="walkthrough__signin-button"
            disabled={busy || disabled || code.trim().length < 6}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="email-signin__help">
            Not there after a minute? Check spam, or{' '}
            <button
              type="button"
              className="email-signin__link"
              onClick={() => void sendCode(true)}
              disabled={busy}
            >
              send a new code
            </button>
            {' · '}
            <button
              type="button"
              className="email-signin__link"
              onClick={() => {
                setStep('email')
                setError(null)
              }}
              disabled={busy}
            >
              use a different email
            </button>
          </p>
        </>
      )}
      {error && (
        <p id={errorId} className="walkthrough__signin-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
