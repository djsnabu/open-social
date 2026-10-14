# Integration decisions — 2026-10-14

## Evidence and limits

- Read-only inspection found the user's Postiz Docker image pinned to `ghcr.io/gitroomhq/postiz-app@sha256:785f97312f66a347fb96cdccc4ded5a33ced69a672c89a9adc8054e7d6a21dc5`. Its root package reports `1.0.0`; no OCI version labels were present. This does **not** establish an upstream release number.
- No live Postiz publish, channel mutation, migration or production data export was performed. Installed OAuth and public API behavior were not replayed. Public API descriptions below are documentation evidence, not a claim that this pinned build supports every endpoint.
- [Postiz public API documentation](https://docs.postiz.com/public-api/introduction) describes channels as integrations, authorization via an API key, and separate draft/schedule/now publishing requests. Its present API includes connection, status, media and post operations. Open Social does not use Postiz as a publishing backend.
- [Postiz's upstream license](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE) is AGPL-3.0. No source, CSS, images or other implementation assets were copied. This is an original MIT implementation against provider APIs, not a relicensed fork.
- [Meta's official Instagram Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-23eacf45-3728-4e41-bcc7-6d164959327c) documents Page discovery with `me/accounts`, Page tokens, professional Instagram accounts and container publication. Only the permissions needed by this implementation are requested.
- Direct retrieval of some Meta developer reference pages was rate-limited. The relevant reference links are included below for account setup. The configured Graph version (`v24.0`) is explicit and replaceable; live compatibility and account-specific access must still be verified with the owner's Meta app.

## Chosen first provider flow

Facebook Login → code exchange → long-lived user token → paginated managed Pages → explicit selection of Facebook Pages / linked Instagram professional accounts → encrypted Page token per channel.

Permissions requested: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`. Additional business-management permissions can depend on how Meta assigns the account; that account-specific setup is not claimed tested. Personal Facebook profiles and Instagram consumer accounts are outside this release.

Facebook publishes text with `/{page_id}/feed` and single images with `/{page_id}/photos`. Instagram creates `/{ig_id}/media`, persists the container ID, waits for `FINISHED`, then calls `/{ig_id}/media_publish`. Publishing results retain the provider ID. Health checks only confirm read access; they cannot certify publishing permission.

References:

- [Pages posts](https://developers.facebook.com/docs/pages-api/posts/)
- [Instagram publishing using Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing/)
- [Manual Facebook Login](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/)
- [Long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/)

## Architecture

Node.js 24+, built-in HTTP and SQLite, static ES modules, one runtime dependency (`sharp`) for bounded image decoding and metadata removal. One application process serves the UI/API and polls the durable queue. No Redis, frontend build or external scheduler is needed for the initial single-owner workload.

Provider tokens use AES-256-GCM. Login passwords use scrypt. Session/API tokens are random and stored by hash. Cookie mutations validate the exact public origin. OAuth state is expiring, session-bound and single-use. The database atomically records mutation idempotency and queue claims.

Automated tests exercise these contracts through real HTTP/SQLite and a fake provider. They do not prove Meta App Review approval, real token exchange, remote media retrieval or social publication. Those remain explicit acceptance tests.
