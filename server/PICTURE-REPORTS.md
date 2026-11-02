# Explicit picture-report sharing

Picture & sound help → Share diagnostics sends a snapshot only when pressed.
The returned 24-character hexadecimal code is a 96-bit random read capability.
Support can retrieve the newest shared reports from its protected inbox without
asking you for a code. The reference code remains an optional way to identify a
particular report. A single report can still be retrieved with:

`GET https://boxxie-share-server.ricky-kundi.workers.dev/api/diagnostics/<code>`

Retrieval needs the code, not the user's password or room code. Anyone holding
the code can read the anonymous report until expiry. Do not post it publicly.
The response is JSON with `report` and `expiresAt`, with caching disabled.
Missing and expired reports return 404. This is a frozen snapshot, not remote
access to the stick or a live dashboard.

## Protected support inbox

`GET /admin/diagnostics` returns at most the latest 10 unexpired shared reports.
It requires `Authorization: Bearer <DIAGNOSTICS_READ_TOKEN>`. Ordinary sessions,
missing/wrong credentials and missing server configuration are refused. This
dedicated credential grants read access to anonymous diagnostics only, not accounts,
rooms, media or server administration. The endpoint is limited to 30 reads/IP/hour.

Maintainer command: `node server/tools/read-picture-reports.mjs`. It reads the
credential from `.local/diagnostics-reader-token` (mode 0600, ignored by Git) and
contacts only the configured production diagnostics endpoint. The corresponding
GitHub Actions secret is synced to the Worker by the existing deploy workflow.
Never paste the credential into a chat, commit, URL or log.

The isolated `diagnostics-inbox` object retains at most 50 code/expiry entries,
updated transactionally and pruned by an expiry alarm. It holds no account IDs.
Only reports uploaded after the inbox was deployed are indexed; older reports
remain retrievable only with their original code until their expiry.

POST `/api/diagnostics` requires the existing signed-in session and allowed web
origin. Both client and server project onto numeric fields and fixed enums;
the server never accepts free-text reports. Stored fields are version, quality
setting, bounded resolution/FPS/bitrate values, UTC sample time, anonymous viewer
ordinal, codec, encoder category, route type and limitation reason. Names,
account IDs, room codes, IP addresses, raw stats, film titles and media are not
stored. Captured source dimensions are not the original movie resolution.

Limits: streamed input up to 64 KiB, at most 8 current viewers and 120 history
rows, 5 upload attempts per account per rolling 24 hours, and 50 accepted uploads
globally per rolling 24 hours. Reads are limited to 60 per IP per hour. Exhausting
an upload allowance refuses the upload; it does not interrupt room playback.

Each report uses the existing SQLite-backed Room Durable Object binding with an
isolated `diagnostics-<code>` object name. No new paid product or plan is added.
An alarm deletes report storage after 24 hours; reads also enforce expiry and
delete expired data. Infrastructure limits remain those of the existing free
account; this feature's caps do not meter unrelated room or relay usage.

The server harness covers sign-in, retrieval without sign-in, privacy filtering,
expiry/alarm cleanup, body size and upload caps. Browser tests cover sharing from
help, receiving a code and retrieving its report without leaving the room.
These checks do not establish physical capture or video-quality improvements.
