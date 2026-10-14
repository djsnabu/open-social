# Agent API v1

Open Social is a **single-owner workspace**. Every key operates in that workspace; scopes limit operations, not individual channels. The UI is Finnish; error codes are stable English identifiers.

Create a key in **Agentit & API**. The plaintext key appears once. Only its SHA-256 digest is stored. Revoke it from the same screen. Keys do not expire automatically.

```sh
export OPEN_SOCIAL_URL=https://social.example.com
# Set OPEN_SOCIAL_TOKEN in your secret manager, not in source control.
curl "$OPEN_SOCIAL_URL/api/v1/channels" \
  -H "Authorization: Bearer $OPEN_SOCIAL_TOKEN"
```

| Scope | Operations |
|---|---|
| `channels:read` | List channels |
| `posts:read` | List/get posts, attempts, private draft images |
| `posts:write` | Create/edit/cancel posts |
| `posts:publish` | Queue immediate publication or schedule an existing draft |
| `media:write` | Upload images |

Connecting/disconnecting channels, managing keys and resolving uncertain publications require the owner's browser session. Agent keys cannot administer those operations.

## Endpoints

All paths are under `/api/v1`. Requests and responses use JSON unless noted. Mutations on posts (except owner-only reconciliation) require `Idempotency-Key: <8–128 letters, digits, underscores, dots or hyphens>`.

| Method and path | Body / response |
|---|---|
| `GET /status` | Setup and publishing availability |
| `GET /channels` | Channel array; never returns provider tokens |
| `POST /media` | Raw JPEG/PNG/WebP bytes, with corresponding `Content-Type`; returns `{id,url,width,height,size}` |
| `GET /posts?offset=0&state=draft` | `{posts,total,nextOffset}`; optional state, pages of at most 200 |
| `GET /posts/:id` | Post |
| `POST /posts` | `{channel_id,text,media_id?,timezone}`; creates a draft only |
| `PATCH /posts/:id` | `{version,channel_id?,text?,media_id?,timezone?}`; editing also unschedules |
| `POST /posts/:id/schedule` | `{version,scheduled_at}`; ISO UTC with `Z`, future instant |
| `POST /posts/:id/publish` | `{version}`; queues, **does not confirm publication** |
| `POST /posts/:id/cancel` | `{version}`; retains content and history |
| `GET /posts/:id/attempts` | Recorded attempts and their outcomes |

`timezone` is an IANA zone such as `Europe/Helsinki`. `scheduled_at` is an unambiguous UTC instant such as `2026-12-01T10:00:00Z`. Convert local wall time before calling the API. The browser rejects DST gaps/overlaps instead of guessing. The original display timezone is retained on the post.

## Example workflow

Upload media if needed. PNG/WebP become JPEG; EXIF metadata is removed. Input is limited to 8 MiB / 40 megapixels, and the output fits within 1440 × 1800 without cropping. Instagram requires one image, aspect ratio 0.8–1.91 and a caption of at most 2,200 Unicode code points. Facebook supports text or one image. Multi-image posts, video, stories and reels are not in this release.

```sh
curl "$OPEN_SOCIAL_URL/api/v1/media" \
  -H "Authorization: Bearer $OPEN_SOCIAL_TOKEN" \
  -H 'Content-Type: image/jpeg' --data-binary @photo.jpg

curl "$OPEN_SOCIAL_URL/api/v1/posts" \
  -H "Authorization: Bearer $OPEN_SOCIAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-2026-12-draft-001' \
  --data '{"channel_id":"CHANNEL_ID","text":"Your approved content","media_id":"MEDIA_ID","timezone":"Europe/Helsinki"}'

curl "$OPEN_SOCIAL_URL/api/v1/posts/POST_ID/schedule" \
  -H "Authorization: Bearer $OPEN_SOCIAL_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-2026-12-schedule-001' \
  --data '{"version":1,"scheduled_at":"2026-12-01T10:00:00Z"}'
```

Each mutation returns the post including its current `version`. Supply that version on the next change; an outdated version returns HTTP 409 (`version_conflict`). Refresh before deciding whether to edit again.

Repeat an interrupted write with the **same key and identical request**. Its response is retained in SQLite, even across restarts. Keys are scoped per agent key (all owner sessions share one principal). A different payload/path with the same key returns 409. Records are deliberately not automatically expired: pruning them would permit old requests to be repeated. Do not retry through a different agent key.

## Publication states

`draft → scheduled → publishing → published | failed | uncertain`

- Immediate publication also enters `scheduled`, due now. Poll the post for its confirmed outcome.
- `published` means Meta returned a publication ID (or the owner verified an existing ID). Reach, moderation and ongoing visibility are not guaranteed.
- `failed` means a definite failure. Fix the error and explicitly publish/schedule again; no automatic retries.
- `uncertain` means the network or process failed around a possible publication. The worker **never automatically republishes** this post. Check the social channel first. The owner can supply a remote ID in the UI; reconciliation verifies the channel and text. It does not verify image equivalence. No blind retry or clone button is offered.
- Work left in `publishing` for ten minutes becomes `uncertain`. A two-second in-process worker claims one due row atomically. Several workers can safely claim distinct rows, but SQLite must remain on one local filesystem.
- After downtime, overdue scheduled work runs when the service returns. Disconnecting a channel turns its queued posts back into drafts.
- Editing scheduled work removes its schedule. Save and schedule again using the new version.

No provider can make an arbitrary timed-out HTTP publication exactly-once. The conservative `uncertain` state prevents automatic duplicates while preserving the evidence needed for a human decision.

## Errors

```json
{"error":{"code":"reconnect_required","message":"Yhdistä kanava uudelleen."}}
```

400 validation, 401 authentication, 403 scope/origin, 404 absent resource, 409 state/version/setup conflict, 413 too large, 415 unsupported media type, 429 login throttling, 502 provider failure. Provider-supplied error text and tokens are not returned or logged.

An API key with `posts:publish` authorizes real publication whenever `ENABLE_PUBLISHING=true`. Use read/write-only keys for planning assistants.
