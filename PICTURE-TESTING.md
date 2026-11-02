# Picture-quality review

## Confirmed code issue addressed by PR 14

Combining portrait `screen.width/height` with a landscape viewport using separate
maxima could classify a phone as a tablet during rotation. The display policy now
uses a single coordinate space. Browser and Android hosts also skip unchanged
display-height requests instead of reapplying sender settings.

## Reviewed behaviour

- Android capture respects the real display shape and selected height ceiling.
- Auto requests are per viewer. Phone requests allow 720p/4 Mbps; larger displays
  allow 1080p/8 Mbps. These are ceilings, not guaranteed received resolutions.
- VP8 uses the existing conservative 720p/2.5 Mbps/24 fps fallback. H.264 is
  preferred; its negotiated codec and encoder are included in picture details.
- WebRTC can reduce resolution below these ceilings under resource or network
  pressure. There is no evidence yet identifying which caused the reported 240p.
- Each Android viewer has a separate sender. Three generated browser streams do
  not establish that a physical stick can encode three streams smoothly.
- Video fills an absolutely positioned container with `object-fit: contain`.
  Received frame dimensions update the quality label, not its CSS dimensions.
- Room overlays use backdrop blur and fading. The real iPhone compositor and
  native video fullscreen still require inspection on a phone; no causal claim
  about strobing is established by these code observations.

## Automated coverage

`server/test/quality_policy.cjs` covers rotation coordinate spaces, screen classes,
manual overrides and bitrate ceilings.

`server/test/e2e_audio.cjs` runs Chromium, Firefox and WebKit. It checks repeated
portrait/landscape viewport changes, stable video geometry, unchanged peer count,
advancing decoded video and received audio energy. Fullscreen events are simulated;
this does not test iOS native fullscreen. Existing scenarios cover pause/resume,
sharing restart, stale signalling and approved-viewer refresh/rejoin.

`server/test/e2e_native_room.cjs` additionally checks three generated-media viewers
continue playback without replacing existing tracks. The Android bridge is a
stand-in, not an Android emulator or hardware capture test.

`server/test/network_adaptation.cjs` shapes actual UDP packets on isolated Linux CI:
healthy 12 Mbps, constrained 150–900 kbps with delay/jitter/loss, then recovery.
It requires advancing picture/audio and useful recovered bitrate and frame rate.
It does not recreate a particular VPN, ISP, relay path or stick encoder.

Android CI compiles the code and runs JVM policy/connection/service tests.
See PR checks for the outcome of each run; this file describes coverage, not a
claim that every run has passed or a physical device has been verified.

## Next physical test

1. One remote viewer, unchanged host/movie/VPN settings: observe inline and
   fullscreen for 5 minutes each. Record room age and received resolution.
2. During poor quality, collect host Picture & sound help → Copy picture details.
   Record encoder, codec, FPS, resolution, measured bitrate, route and limitation
   reason. Returning to a static Boxxie screen can change those statistics.
3. Repeat with a second viewer. Compare per-viewer detail and limitation reason;
   do not infer available media bandwidth solely from a speed-test result.
4. Check pause/resume, movie changes and approved viewer refresh, then continue
   beyond 30 minutes. Keep actual audio/background-capture findings separate
   from generated-media and synthetic-beep tests.

No minimum bitrate, forced encoder resolution, signing changes, paid services or
source-app protection bypasses are introduced by this fix.
