-- 0006_user_api_keys.sql — per-user BYO Anthropic API key, encrypted at rest.
--
-- Replaces the SPA's plaintext-localStorage key storage: the key now lives
-- server-side, AES-256-GCM encrypted under a key HKDF-derived from
-- SESSION_SECRET with info 'eex/user-api-key/v1' (services/userApiKeys.ts).
-- `ciphertext` is base64(iv || ct || gcm-tag) with the owning sub bound as
-- AAD, so rows cannot be swapped between users at the storage layer.

CREATE TABLE IF NOT EXISTS user_api_keys (
  sub        TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
