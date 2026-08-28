import { apiUrl } from './base'

export type ClaimResult = { ok: true; device_name: string; device_platform: string }

/** Bind the signed-in member to a device's pairing code. Throws with a short reason on failure. */
export async function claimDeviceLink(code: string): Promise<ClaimResult> {
  const res = await fetch(apiUrl('/api/auth/device/link/claim'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (res.ok) return (await res.json()) as ClaimResult
  const err = ((await res.json().catch(() => ({}))) as { error?: string }).error
  const reason: Record<string, string> = {
    unknown_code: 'That code isn’t recognised. Check it on the device and try again.',
    expired: 'That code has expired. Ask the device for a new one.',
    already_claimed: 'That code was already used.',
    invalid_code: 'Codes are 8 letters and numbers.',
  }
  throw new Error(reason[err ?? ''] ?? `Couldn’t link the device (${res.status}).`)
}
