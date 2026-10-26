# Playback capture follow-up after 1.0.19

Physical-device reports: the generated WebRTC beep is audible in iPhone Safari. Hot Player 2.2.4 and The Stream Team have sound on the Xiaomi stick/TV, but the phone reports silent incoming audio. An owned MOV played with VLC also has sound on the TV and no sound on the phone. VLC's picture appears on the phone while the TV displays the VLC/secondary-display logo.

These reports do not prove a source application blocks capture. The existing beep bypasses Android playback capture. Do not describe the playback-audio defect as resolved.

## Changes

- Adapt WebRTC's m144 screen capturer to use a private AUTO_MIRROR display, without PUBLIC or PRESENTATION. The existing presentation flags make the capture display eligible as a secondary playback target. The capture lifecycle and modern-Android resize behaviour are retained. WebRTC's licence and patent notices are included in APK assets.
- Add **Test TV sound capture** on the sharing TV when the native API is available. It plays a four-second 660 Hz PCM tone through Android AudioTrack, USAGE_MEDIA, with capture explicitly permitted. This does not inject any samples into the outgoing WebRTC callback.
- Keep the existing three-second outgoing beep as a separate transport check.
- Replace diagnostic wording that assumed application blocking/Dolby with a description of the measured silent/no-data state.

## Required device verification

1. Keep the phone joined; on the TV press **Test TV sound capture**. Confirm whether the tone is audible on the TV and phone, and inspect captured/input peaks during the four-second tone.
2. TV and phone tone audible: the Android capture path can work in this session; investigate the third-party players' capture/output paths next.
3. TV tone audible but phone silent with captured/input peaks zero: Android's capture/mix path is returning silence even for explicitly capturable local audio. Investigate device routing and recorder configuration rather than Safari or source-player policy.
4. Captured/input peak nonzero but phone silent: compare outgoing PCM and received audio energy; this is a different failure from silent capture.
5. Reopen the owned MOV in VLC and check that picture remains on the TV while sharing. Recheck normal player sharing, stop/restart and reconnection.

The browser integration test verifies only bridge wiring and normal WebRTC playback with a simulated Android host. Compilation and browser tests cannot validate the Android audio mixer or display routing on the Xiaomi.

Upstream source: https://github.com/webrtc-sdk/webrtc/blob/m144_release/sdk/android/api/org/webrtc/ScreenCapturerAndroid.java
Android display flags: https://developer.android.com/reference/android/hardware/display/DisplayManager

## Background result after 1.0.22

The user reports the Android capture-test tone is audible on both TV and phone while
Boxxie is visible. Pressing Home stops that tone on the phone while it continues on the
TV. Hot Player and Stream Team still have no remote audio. This isolates an activity
foreground/background transition; source-player policy is not established as the cause.

ScreenShareService declared and activated only mediaProjection. The follow-up adds
the microphone foreground-service type for Android 11+ when RECORD_AUDIO is granted,
alongside the existing projection type. Android uses this recording capability for
AudioRecord; the audio device still runs recording-less WebRTC and playback capture,
without opening the hardware microphone. Android 14+ permission refusal retains video
with an explicit error instead of silently promising background audio.

Regression coverage checks SDK/permission boundaries and the actual manifest contract.
The necessary physical check remains: start the tone, press Home immediately, and confirm
the phone continues hearing it, then repeat playback in the two third-party players.

## Viewer refresh and UI rules

The phone viewer now remembers its approved room per tab and account across a refresh.
Transient ticket/network failures retry; stale socket events and overlapping reconnects
cannot replace the current connection. Explicit leave/sign-out, host removal and closed
rooms clear recovery state as appropriate. Server-side approval and authentication stay
authoritative. Automated browser scenarios cover locked-room refresh, failed ticket
fetches, manual rejoin and removal, with auth seeded only once before navigation.

Sound-test buttons and screen-action buttons use matching dimensions within each group.
TV and phone viewport geometry checks and rendered previews verify alignment and preserve
visible keyboard/remote focus outlines. The persistent development rule is in AGENTS.md.

Android recording service type: https://developer.android.com/reference/android/content/pm/ServiceInfo#FOREGROUND_SERVICE_TYPE_MICROPHONE

## Pause/resume follow-up

After 1.0.24 the user confirms both third-party players share audio successfully,
but reports that TV playback resumes after a pause while the phone stays frozen
with neither moving picture nor sound. The precise physical failure is not yet
measured. Browser recovery previously ran only when tracks were attached.

The viewer now retries a paused media element on track unmute, page return and
continued decoded frames, retaining the sound retry control if playback is denied.
A failed or persistently disconnected screen connection requests a fresh native
peer for that approved viewer; sustained undecodable incoming video also requests
repair. Intentional static source frames do not trigger decoder repair. Repairs
are rate limited and do not restart the host player or room.

Tests pause and resume the simulated source on the same tracks, interrupt viewer
playback, require new decoded frames and audio energy, then simulate failed media
ICE while the signalling socket remains connected. Physical stick pause/resume
still needs verification after the web update.

## Outside-home picture report

The user reports choppy picture for an external Wi-Fi viewer while the stick's
VPN was enabled. A supplied 7.65-second WhatsApp recording shows playback and a
return to the player menu; its recompressed 384x832 capture does not establish the
original live frame rate or end-to-end latency. The deployed relay health endpoint
reports Cloudflare credentials are configured; this does not prove the route or
throughput of the reported session.

HD's video bitrate cap is 8 Mbps per viewer, with a separate outgoing stream for
each viewer. Add a selectable Smooth 720p profile capped at 2.5 Mbps video per
viewer, preserving HD as the default. Existing Android 1.0.24 already accepts the
profile's height and bitrate configuration, so this option needs a website update,
not a new APK. These are caps, not measured usage or promised upload requirements.

Phone diagnostics now expose measured received video bitrate and, when available,
selected candidate route/transport, round-trip time and decoded frame rate. No
candidate addresses or relay credentials are displayed. Compare the next remote
session on Smooth 720p and, if practical, a VPN-bypassed Boxxie session before
claiming which network component caused the problem. Browser tests use local ICE
and cannot validate an outside-home/VPN route or stick encoding performance.

## Startup card resize

The TV page previously exposed the home screen before deferred app setup, applied
TV sizing later, then scheduled another shrink from a body ResizeObserver. A
remote display-swap font could also change text metrics after first render.

A small head script now establishes TV classification and base scale before body
paint. Home stays hidden until the selected screen is ready, and show() computes
its final fit synchronously before revealing it. Remove the observer-driven late
shrink. Bundle the same Inter Latin variable font and its OFL locally, preload it,
and use optional font display to avoid a late swap. The offline shell includes
both startup assets. Cold-load tests hold app.js, verify the uninitialised home is
hidden, then compare card geometry before/after fonts settle.

## Resolution selection stability

The user reports that selecting picture resolution makes the TV controls grow and
then resize. Locally, HD/4K/Smooth selection changed the host card height by up to
36 pixels at a 1280x720 viewport because each help paragraph had a different
natural height. TV resize handling also reset fitted zoom on every resize event,
even with unchanged viewport dimensions.

Stack all quality notes in one grid cell so the longest reserves its natural
height; show and expose only the selected note. Ignore resize events when viewport
width and height have not changed, while retaining fitting on actual resizes.
Frame-by-frame geometry checks cover repeated profile switches at 960x540,
1280x720 and 1920x1080, including unchanged-viewport resize notifications. Local
checks show constant card/button bounds and no zoom writes during selection.
The reported stick behaviour still needs physical verification after deployment.
