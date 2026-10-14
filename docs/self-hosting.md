# Self-hosting

## Local setup

```sh
npm ci
npm run setup
npm start
```

Node 24+ is required. `npm run setup` creates an owner-readable `.env` and `data/initial-password.txt`. It refuses to overwrite an existing configuration. Open `http://localhost:4310` and sign in using the generated password. The service binds to loopback by default; it does not open a public port.

The setup file contains a password hash and encryption key. Keep `.env` private and backed up with the database. Losing `APP_KEY` makes existing channel tokens unreadable. Never paste secrets into issues or commit `.env`, data files, authenticated captures or screenshots containing API keys.

## Public HTTPS / Meta setup

1. Choose your public origin, e.g. `https://social.example.com`, and terminate HTTPS with your reverse proxy or tunnel. Forward to port 4310 and preserve the original Host header. Protect the upstream port from direct access. Do not log query strings on `/auth/meta/callback` (authorization codes) or request bodies/Authorization headers.
2. Set `PUBLIC_ORIGIN` to that exact origin, with no path, query or credentials. Non-local origins require HTTPS. Set `HOST=0.0.0.0` only if the proxy needs access outside loopback; use firewall/container bindings appropriately.
3. Create a **separate Meta developer app** for Open Social. Configure Facebook Login and the required Instagram capability. This is your application's credential set, not a copied Postiz token.
4. Add this exact valid OAuth redirect URI: `https://social.example.com/auth/meta/callback`. Configure the matching app domain. Meta can require a privacy policy, data deletion instructions, business verification and App Review/advanced permission access before you connect other users' accounts. Those account-specific requirements must be completed in Meta's developer dashboard.
5. Set `META_APP_ID`, `META_APP_SECRET` and the Graph API version supported by your app (`META_API_VERSION` defaults to `v24.0`). Restart Open Social after changing environment variables.
6. In **Kanavat**, select **Yhdistä Metaan**. Grant the required Page and Instagram permissions. Select only the channels you intend to use. Facebook Pages need a content-creation/management task; Instagram must be a professional account linked to a returned Page for this flow.
7. Use **Tarkista** for a read-access check. This does not prove publishing permission. If a required Page does not appear, review the account's Page tasks, the Pages selected during consent, the linked Instagram account and the app's granted permission access. Reconnect after fixing access.
8. Choose an explicit test account and approved test content. Set `ENABLE_PUBLISHING=true`, restart, then test both immediate and scheduled publication. Confirm the post on the actual platform, not only the API response. Keep publishing disabled until ready.

Requested scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Development-mode access and permissions are controlled by Meta, not Open Social. Do not grant production access merely to test the UI.

Images remain authenticated while only attached to drafts or scheduled work. When publishing starts, the image URL becomes public so Meta can fetch it; it stays public for published or uncertain posts. Images can be cached by external services after publication. Serve `/media/` directly through the proxy without an extra login wall. No separate object storage is required.

## Docker

Create `.env` with the local setup command first. Then:

```sh
docker compose up -d --build
docker compose logs --tail=30
```

The container runs as the non-root Node user, exposes only `127.0.0.1:4310` on the host, and stores SQLite/media in the `open-social-data` named volume. The named volume is separate from a local Node installation's `data/`; existing local records are not automatically copied. The owner password remains the one generated in the host `.env`.

The example Compose file fixes the internal port to 4310; leave `PORT=4310` unless you also update its port mapping and health check. Do not use `docker compose down -v` unless you intend to destroy the application's data. A five-minute shutdown grace period lets a running Meta request finish.

## Operations

- `GET /healthz` reports whether HTTP is serving; it does not certify provider connectivity or publication success.
- Keep the process running for scheduled work. Overdue posts are picked up when it returns. The queue uses the server's UTC clock, so keep system time synchronized.
- Back up the SQLite database and media together. The simplest consistent backup is to stop this application's process briefly and copy its complete data directory/volume plus `.env`. Restore on a separate instance and verify decryption before replacing anything. Do not copy only the `.db` while WAL writes are running.
- Preserve the database and `APP_KEY` across restarts. Never store SQLite on an NFS/network share or run copies on independent filesystems against one supposed queue.
- Sessions expire after 24 hours. API keys stay valid until revoked. Rate limiting allows ten login attempts per remote address per 15 minutes, resetting after success. Behind a proxy, addresses are intentionally not trusted from forwarded headers, so this is a shared login limit.
- This first release is one trusted owner/workspace, not a public multi-tenant service. Agent key scopes do not isolate channels or tenants.
- `uncertain` posts require a channel check. There is no automatic retry, because a timed-out request may already have published. The UI accepts a provider ID for a read-only reconciliation check. Do not create a replacement until you establish whether the original appeared.
- Token/permission expiry can happen independently of the application. Read-access checks are on demand; there is no continuous expiry monitor. Errors request reconnection where appropriate.
- No automatic content deletion or media garbage collection is implemented. Unused uploads and idempotency records are retained. Monitor disk use and plan a reviewed retention policy before high-volume use.

## Before production

The automated tests use fake providers. Complete these with the chosen Meta test account:

- Consent, account discovery, selection, reconnect and disconnect.
- Facebook text and image publication; Instagram image publication.
- Public image retrieval from Meta, including TLS and any tunnel/proxy rules.
- Correct visible caption/image and published URL/ID on each platform.
- Schedule across a local timezone boundary; edit/cancel before publication.
- Restart before a future due time and confirm one publication.
- Revoke a token and confirm the error and reconnect path.

External provider behavior, App Review and remote publication are not certified by the local alpha tests.
