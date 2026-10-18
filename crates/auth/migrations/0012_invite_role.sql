-- 0012_invite_role.sql — invites carry the role they grant.
--
-- An admin can mint an "owner invite": the member created (or re-granted) by
-- redeeming it gets role 'admin' instead of 'user'. Needed wherever the new
-- member's provider sub is unknown in advance (App Review's reviewer account,
-- a partner who has never signed in), so ADMIN_SUBS cannot list them yet.

ALTER TABLE invites ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));
