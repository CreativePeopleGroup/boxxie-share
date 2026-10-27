# Investigating room disconnections

Workers Logs is enabled in `wrangler.toml`. No paid logging service is added.
Automatic invocation logs are disabled because WebSocket request URLs contain
one-use tickets and host secrets. Custom events never include URLs, credentials,
room codes, account IDs, names, IP addresses, SDP, ICE candidates or raw socket
close text. Cloudflare's own error/platform metadata is separate from these
custom events.

The server completes the WebSocket close handshake explicitly (required with
its pre-April-2026 compatibility date). An errored socket is retired and closed
so it cannot keep answering pings as if the room still had a healthy host.

In Cloudflare, select **Workers & Pages → boxxie-share-server → Observability**.
Find events around the reported test time, then filter on the anonymous `roomRef`
to follow that room. New rooms receive a random persistent reference; rooms
created before this deployment use their opaque Durable Object ID. Cloudflare
supplies the log timestamp. These are diagnostic references, not join codes.

| Event | What it tells us |
| --- | --- |
| `room_created` | Start of a new room. |
| `room_runtime_loaded` | First access in a runtime; can be normal hibernation or deployment, not proof of a crash. |
| `host_connected` | Initial connection or recovery, recovery duration, and whether the authenticated host bypassed a shared-IP guessing block. |
| `host_disconnected` | Socket close/error, numeric close code when available, connection duration, age of the latest application ping, and grace allowance. An error followed by close is counted once. |
| `room_connection_refused` | Server refusal reason and requested role. No room reference is logged for an unverified attempt; compare the time with the host events. |
| `room_closed` | Closure reason, room age, missing-host duration, whether a host was present and the viewer count. |

For the next device test, note the start time, VPN state, player, and time the
picture first freezes. Save the picture details from the host and the viewer's
on-screen statistics. Compare these with the connection timeline. The server
does not receive or inspect the video and these events do not measure frames
encoded or decoded. Audio continuing does not prove signalling is connected.

The room still allows three minutes for host recovery. This change does not
extend that period, introduce native heartbeats, or claim to repair video
capture. A verified host must supply both a valid sign-in ticket and the room's
host secret; the exception does not revive closed rooms or remove viewer/pairing
guessing limits.

At deployment, Cloudflare's Workers Free documentation lists 200,000 log events
per day and three-day retention. Review the test logs promptly. No ping-by-ping
or media-packet logging is enabled. Account-wide limits still apply. Pricing:
https://developers.cloudflare.com/workers/observability/logs/workers-logs/
