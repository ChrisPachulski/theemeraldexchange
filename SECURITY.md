# Security Policy

The Emerald Exchange is a self-hosted, invite-gated media server. The public
repository is source-visible under a proprietary license; there is no public
deployment to test against.

## Reporting a vulnerability

Email **pachun95@gmail.com** with a description, the affected component
(`server/`, `crates/media-core`, `crates/transcoder`, `recommender/`, the SPA,
or the Apple app), and reproduction steps. Please do not open a public issue
for anything exploitable. You will get an acknowledgement within a week.

## Scope

In scope: authentication and authorization (sessions, device tokens, stream
tokens, invites, admin gates), the internal-principal bridge between services,
SSRF and path-confinement guards, and anything reachable from a signed-in
member's browser or app.

Out of scope: denial of service against a single-household server, findings
that require operator-level access to the NAS, and third-party services
(Plex, Sonarr, Radarr, SABnzbd, WorkOS, Cloudflare).
