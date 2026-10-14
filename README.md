# Open Social

An open-source, self-hosted social publishing app designed for mobile users and AI agents.

**Status: working local alpha.** Mobile-friendly Finnish UI, an authenticated agent API, SQLite scheduling, original Facebook/Instagram provider code, and automated tests are implemented. **Real Meta OAuth and social publication still require acceptance testing with your own app and a designated test account.** Publishing is disabled by default.

## Run locally

Requires Node.js 24+ (including its built-in SQLite module).

```sh
npm ci
npm run setup
npm start
```

Open **http://localhost:4310**. Read the generated login password from `data/initial-password.txt`; the setup command does not print secrets. `.env` and `data/` are excluded from Git. On Linux with a custom global libvips, use `SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm ci` to use sharp's packaged binaries.

The initial workspace is empty. Configure your own Meta app to connect actual channels. There are no pretend live accounts or imported production posts.

## Implemented

- One owner login; expiring HttpOnly sessions and origin checks.
- Facebook OAuth with expiring, single-use state; explicit Page/linked Instagram selection and reconnection.
- AES-256-GCM encryption of channel tokens and read-only connection checks.
- Drafts, JPEG/PNG/WebP uploads, image validation, previews and editing. Built-in cropping offers 4:5, 1:1 and 1.91:1 with drag positioning and zoom.
- Persistent UTC schedules with an IANA display timezone, DST ambiguity detection and a responsive calendar/list.
- Immediate publication queue, recorded attempts, idempotent writes, optimistic edit versions and conservative handling of ambiguous outcomes.
- Scoped and revocable agent keys; a documented `/api/v1` API.
- Local stdio MCP server for channels, drafts, images, scheduling and publication, using a scoped API key.
- Docker Compose packaging and GitHub Actions checks.

This release supports Facebook Page text / single-image posts and linked Instagram professional-account single-image posts. It does not include teams, video, carousels, stories, analytics or Postiz migration. MCP publication requires a key with `posts:publish` and enabled server-side publishing.

## Documentation

- [Self-hosting and Meta setup](docs/self-hosting.md)
- [Agent API, examples and failure handling](docs/api.md)
- [MCP setup and available tools](docs/mcp.md)
- [Evidence, architecture and integration limits](docs/research.md)

## Checks

```sh
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

For an existing Chromium, use `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`. Browser tests run in temporary workspaces with a fake provider, never your configured Meta account. Screenshots are written to ignored `artifacts/`. CI runs on Node 24.

## First release

The first release must support this complete workflow:

1. Connect a social channel and see whether the connection is healthy.
2. Create a post with text and supported media, then preview it for the selected channel.
3. Publish immediately or schedule it for a specific date, time, and timezone.
4. View and edit scheduled posts in a calendar that works on a phone.
5. See confirmed publication results, actionable errors, and reconnect prompts.

Channel connections are the highest priority. Facebook and Instagram are the initial candidates based on the existing Postiz integration; supported account types and publishing permissions still need verification.

## Mobile and agent access

- The complete publishing workflow must work on a narrow phone screen with accessible touch controls.
- Agents use a documented, versioned API with scoped credentials and machine-readable errors.
- Validate a post before scheduling or publishing it.
- Repeated requests and worker retries must not create duplicate publications.
- Record publication attempts and distinguish scheduled, publishing, published, and failed states.
- The MCP integration exposes preparation and publication through the same scoped API.

## Implementation milestones

- [ ] Inspect installed Postiz channel/API behavior (image identity checked; live behavior still unverified).
- [x] Select first providers and document OAuth requirements, with account-specific access still to verify.
- [x] Choose the application stack and document local setup.
- [x] Implement account authentication, channel connection, status, and reconnection.
- [x] Implement drafts, media validation, previews, and immediate publishing (fake-provider tests).
- [x] Implement durable scheduling, timezone handling, and publication reconciliation.
- [x] Build and verify the mobile calendar and post editor.
- [x] Document and test agent API authentication, validation, and idempotency.
- [x] Provide self-hosting instructions and an example configuration without secrets.
- [ ] Test the complete workflow with a designated test account before production use.

## Development boundaries

Develop and test independently of the existing production Postiz installation. Data migration is undecided. Live social publishing requires an explicitly selected test account and publication content.

Study the available source and API contracts first; use runtime inspection where actual installed behavior needs verification. Review upstream licensing before reusing third-party code or assets. The MIT license below covers original contributions to this repository.

Never commit credentials, OAuth tokens, production database exports, private post content, or captured authenticated traffic.

## License

MIT. See [LICENSE](LICENSE).
