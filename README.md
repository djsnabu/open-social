# Open Social

An open-source, self-hosted social publishing app designed for mobile users and AI agents.

**Status:** planning. This repository does not yet contain a working application.

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
- An MCP integration can expose the same operations after the core API works.

## Implementation milestones

- [ ] Inspect the installed Postiz version, channel flows, and API behavior using read-only access.
- [ ] Confirm the first channel providers and their OAuth requirements.
- [ ] Choose the application stack and document local setup.
- [ ] Implement account authentication, channel connection, status, and reconnection.
- [ ] Implement drafts, media validation, previews, and immediate publishing.
- [ ] Implement durable scheduling, timezone handling, and publication reconciliation.
- [ ] Build and verify the mobile calendar and post editor.
- [ ] Document and test agent API authentication, validation, and idempotency.
- [ ] Provide self-hosting instructions and an example configuration without secrets.
- [ ] Test the complete workflow with a designated test account before production use.

## Development boundaries

Develop and test independently of the existing production Postiz installation. Data migration is undecided. Live social publishing requires an explicitly selected test account and publication content.

Study the available source and API contracts first; use runtime inspection where actual installed behavior needs verification. Review upstream licensing before reusing third-party code or assets. The MIT license below covers original contributions to this repository.

Never commit credentials, OAuth tokens, production database exports, private post content, or captured authenticated traffic.

## License

MIT. See [LICENSE](LICENSE).
