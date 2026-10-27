# Automatic quality and stream reliability

## What Auto does

Auto guides WebRTC's existing congestion/resource adaptation rather than adding a
competing fixed-interval rate controller. Its ceiling is 1080p and 8 Mbps of video
per viewer on larger displays. Smaller screens request 720p and up to 4 Mbps.
The viewer's screen/viewport dimensions provide a display-size heuristic, not a
benchmark of decoder capacity. Each approved viewer sends their own bounded
request through the existing encrypted signalling connection. Manual host quality
still wins. Smaller-screen Auto favours frame rate. Larger-screen Auto balances
resolution and frame rate so that motion does not always take precedence over
detail. Both remain subject to WebRTC's network and resource adaptation.
The Android sender gives each new peer a one-time starting bandwidth estimate
of at most 2.5 Mbps (or the lower configured ceiling), with no forced minimum.
If the engine rejects the hint it retains its normal estimate. Native diagnostics
report whether the API accepted it; acceptance does not prove a faster/sharper
startup on physical hardware. There is no browser SDP bitrate manipulation.
The existing conservative VP8
fallback stays capped at 720p, 24 fps and 2.5 Mbps. These are upper limits, not
promised throughput, frame rates or upload requirements; audio and transport add
overhead. Manual quality modes remain available.

Viewers can select **Watching on → TV / AirPlay** to request the larger-display
budget, including when browser screen mirroring does not expose the destination
resolution. Safari's wireless-playback event also requests that budget when
available; it does not guarantee AirPlay support for a WebRTC stream. The explicit
choice is saved locally. No upscaling invents extra source detail, no 4K is selected
automatically, and VP8's conservative stick fallback remains unchanged. Higher
ceilings can increase host upload and relay usage. Real AirPlay and stick testing
remain necessary. WebRTC's negotiated codec and built-in congestion/resource
adaptation handle decoder/encoder and network limits; this is not a custom
hardware capability benchmark or a guaranteed quality-recovery schedule.

Auto is the default when the Android bridge advertises support, or for a browser
host. Older installed Android apps retain HD as their default and hide Auto until
updated. This avoids claiming the new sender policy works in an older binary.

## Understanding a device

Account information shows the app-reported manufacturer/model, Android release and
WebView version. This metadata is displayed locally, not uploaded by this feature.
The active stream status adds the actual encoded resolution to existing codec,
encoder, frame-rate and CPU/bandwidth limitation information. Reported capabilities
are useful context, not proof that a particular player permits audio capture or
that the encoder sustains its maximum resolution. Actual running stats and a short
physical capture test provide that evidence.

## Simulated network validation

The host's **Picture & sound help → Copy picture details** button exports selected device/version
metadata and numbered per-viewer resolution, fps, measured bitrate, target bitrate
when available, codec/profile/encoder and selected route. Names, room codes, peer
IDs, candidate addresses and raw stats are excluded. A readable report is shown
if the TV WebView has no clipboard. A network limitation is not attributed solely
to host upload: the bottleneck may be elsewhere along the path. Reported codec
profile and target bitrate are marked unknown when the engine does not expose
them. No diagnostics are uploaded automatically.

Host signalling retries temporary ticket-fetch errors and WebSocket construction
or pre-open failures. Ticket requests time out after eight seconds. Wake/online
events and a 15-second host watchdog detect stale sockets after 90 seconds without
server messages, with retries capped at five-second intervals. Existing media
tracks stay alive during ticket failures. This does not guarantee recovery if an
OS suspends all page execution. Server closure/expiry, invalid host credentials,
account expiry and a replacement host remain authoritative: a closed room is not
silently recreated. The server's three-minute host grace period is unchanged.
Viewer messages distinguish host-connection timeout from an explicit host End.
Every replacement native viewer peer gets a fresh negotiation session ID; queued
ICE/state/SDP callbacks from a replaced peer are ignored. The browser also detects
changed SDP origin IDs for older APKs that reused capture-level session IDs, and
retains a bounded candidate queue across that legacy replacement. Repeated host
recovery is tested with both current and legacy signalling formats.

The Chromium CI scenario uses a moving, complex synthetic picture and generated
audio. Linux traffic control applies bandwidth limits, delay and packet loss to
loopback UDP packets, while leaving TCP signalling/browser automation unshaped.
It verifies a real UDP media path, actual packets through the shaper, reduced
received video bitrate under a constrained link and recovered bitrate after the
constraint is removed. Fresh decoded frames and audio energy must continue.
This proves browser/WebRTC behaviour under a controlled impairment. It does not
prove Xiaomi/Fire TV hardware encoding, vendor background behaviour, a particular
VPN tunnel, NAT topology or a public TURN route.

The normal Chromium, Firefox and WebKit suite also checks refresh/rejoin, failed
media-peer recovery, source pause/resume, playback refusal, approval/removal and
stable TV/phone layouts. Android unit checks enforce Auto ceilings and fallback
budgets; compilation verifies the pinned SDK supports the sender parameters.

## Reliability work after the Auto baseline

1. Run bounded 30-minute, then two-hour continuous-media tests. Track fresh frames,
   audio energy, freezes, reconnect duration and resource counts. Repeat with
   viewers joining/leaving and deliberate network loss. Establish a memory trend
   after warm-up, rather than treating normal garbage collection as a leak.
2. Add forced TURN/UDP and TURN/TCP scenarios on a dedicated test relay and separate
   network endpoints. The current local-ICE test does not validate public relay
   routing. Exercise changed IP addresses and restrictive firewall conditions.
3. Use Android emulators for permission/lifecycle/API coverage and available real
   phones for browser checks. Retain the existing Xiaomi/iPhone physical capture
   check and gather additional volunteer device reports. Browser profiles and
   emulators do not reproduce Fire OS or a stick's hardware codec/thermal limits.
4. Check expected 12-hour room expiry separately from unexpected stream failures.
5. Introduce aggregate session-health monitoring and a small staged release group,
   keeping stream contents and authentication credentials out of diagnostics.
   Use regressions to block releases, clear recovery/status controls for network
   failures, and a tested rollback path.

Zero failures cannot be guaranteed for arbitrary devices, source apps and internet
connections. The objective is measured supported conditions, early detection,
bounded recovery and preventing known failures from returning. No two-hour soak,
public-relay, VPN or new hardware result should be claimed from the short CI test.

## Upload scaling: SFU option

Today the stick sends a separate peer stream to every viewer. An SFU receives a
publication (or a small set of quality layers) from the host and forwards it to
viewers. This reduces the host's upload growth as the room grows. It requires
media-server integration, room-access enforcement and a capacity/cost decision;
a TURN relay alone does not make this architectural change. Cloudflare Realtime
SFU is one option to assess alongside alternatives, not an infrastructure change
made by this update.

References:
- https://webrtc.googlesource.com/src/+/HEAD/video/g3doc/adaptation.md
- https://man7.org/linux/man-pages/man8/tc-netem.8.html
- https://developers.cloudflare.com/realtime/sfu/
- https://developer.android.com/studio/run/emulator-acceleration

## Capacity and media-cost requirement

The room selector defaults to three viewers and still offers up to eight. Changing
picture quality must not silently lower a user's selected viewer count. The API's
fallback default is also three; this does not automatically reduce an open room.

The user requires $0 media-service charges. No SFU is introduced by this update.
Cloudflare SFU and TURN share a 1,000 GB allowance, then charge for egress. Budget
alerts do not enforce limits, and stopping new credentials does not stop existing
relay allocations or guarantee zero overage. An app-side estimate is not a billing
hard cap. Provider-enforced non-billable limits or a direct-only mode are required
before promising strictly zero relay costs. Changing current relay availability
requires an explicit decision because it can prevent VPN/restrictive-network users
from joining; no live billing/relay setting has been changed here.

Pricing: https://developers.cloudflare.com/realtime/sfu/platform/pricing/
Budget alerts: https://developers.cloudflare.com/billing/manage/budget-alerts/
