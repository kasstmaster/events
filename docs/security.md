# Security boundaries and release prerequisites

This is a new application in `kasstmaster/events`. It does not read, migrate, write to or deploy the existing Meyers Gatherings site or its private data repository. The reference informed adult-level RSVPs, child association, declined attendance, menu claims and deadline behavior; its codebase was not copied.

## Trust boundaries

- Administrators approve host email addresses and manage shared invitation artwork. They do not receive guest databases through the administration API. The bootstrap CLI requires operator-supplied credentials and never ships a default password.
- Hosts own one household each, with reusable guests, addresses and independent events. Record access includes both the record ID and the authenticated household. A record ID from another tenant produces no usable private data.
- Guests receive only events inviting their adult ID, the invited children associated with that adult, their own response/claims, aggregate attendance counts and menu availability. Other names, household addresses and RSVP details are excluded.
- Public household links return only household ID/slug, display name and login design. Treat those branding settings as public. A stable QR is a navigation link, not an authentication credential.
- Images are administrator/host-provided raster data URLs. They are not uploaded to a third party. Registry URLs are external navigation only; the server never fetches them. Registry links open with `noopener noreferrer`.
- Cookies, password hashes and sessions never appear in client API payloads or application logs. Request failures log only an error type/code, not request bodies. SQLite files and their containing directory must remain private.

Names alone cannot distinguish the real invitee from someone who knows that name. Rate limits and data minimization reduce exposure; they cannot provide identity assurance. Exact same-name/suffix duplicates fail closed rather than selecting an arbitrary account. Hosts must correct ambiguous records with the actual guest; the application never offers a list of matching private accounts or invents identifying suffixes. Children cannot authenticate independently.

## Synchronization and consistency

SQLite WAL and transactions protect centralized state. Host mutations use optimistic versions. Guest capacity is calculated from current committed responses inside an immediate transaction, with per-adult RSVP versions. Data persists without live browser sessions and reads are never backed by local storage. Polling has a 10-second latency and pauses during editing; offline writes are not queued or replayed.

The server uses UTC calendar dates for deadline enforcement. Deadline increases are disallowed while attendance changes and claim reductions remain available. Existing over-capacity claims are intentionally retained if the host lowers a menu target.

## Before any approved Internet deployment

1. Choose a domain, server and private durable database volume; set the exact HTTPS `APP_ORIGIN`, `NODE_ENV=production` and listener settings. Terminate TLS at a trusted edge and keep the database, bootstrap environment and filesystem backups private. The server sets Secure cookies and HSTS for HTTPS origins.
2. Use a supported Node.js 24 release and `npm ci` from the committed lockfile. Run both automated suites. No source rewrite or frontend secret injection is needed.
3. Provide a real administrator password securely; clear bootstrap variables after use. No email provider, verification service or automated mail workflow exists.
4. Configure access and rate limits at the trusted edge. The application uses the TCP peer address and intentionally ignores forwarded IP headers. All clients behind one reverse proxy currently share its application-level IP limit (30 attempts per operation per 15 minutes); email/name-specific limits are separate (10). Do not blindly trust arbitrary `X-Forwarded-For`. Multi-replica or high-volume operation needs a reviewed trusted-proxy/rate-limit strategy.
5. Establish consistent SQLite backups and a tested restoration process. Use one writable server/database instance; do not give replicas independent database copies. Stored images make backups larger; consider an authorized tenant-scoped object store for larger installations.
6. Accept the documented name-only guest identity limitation or approve a stronger guest credential model before storing information requiring stronger assurance. The present application does not include host MFA, password recovery, account disabling, or a security audit trail. Do not claim those capabilities exist.

These are documented deployment prerequisites, not an authorization to deploy. Nothing is deployed, merged or connected to production by this pull request.
