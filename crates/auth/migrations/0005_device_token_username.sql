-- 0005_device_token_username.sql — Store the pairing-time username alongside
-- device bearer rows so per-request reconcile can recompute legacy ADMINS
-- role membership instead of trusting the long-lived JWE role claim.

ALTER TABLE device_tokens ADD COLUMN username TEXT;

