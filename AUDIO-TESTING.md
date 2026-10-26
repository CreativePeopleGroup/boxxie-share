# Audio fix and compatibility testing

The receiving-device target is current iPhone/iPad Safari, Android Chrome and the Android app, desktop Chrome/Edge/Firefox/Safari, and Android TV/Fire TV devices capable of installing the Android app. Apple TV needs the existing mirroring route; TVs without a supported browser or installable Android app need a separate client. These are test targets, not a claim that every model has been verified.

## Implemented changes

- Recreate the Android playback recorder after a negative read, including a dead audio service. Previously these errors were ignored indefinitely.
- Validate recorder format, initialisation and recording state rather than treating construction as success.
- Protect recorder reads, creation and release with the same lock. Clear old samples and sound state on stop/restart.
- Use the pinned WebRTC recording-less API directly, so an incompatible dependency fails compilation rather than silently reverting to microphone capture.
- Request that WebRTC disable software voice processing for film audio, in addition to the existing hardware processing settings.
- Keep the viewer's sound button available if playback is refused. This applies to every browser using the viewer.
- Bind a fresh viewer MediaStream when tracks change, retaining the live track of the other kind. WebKit testing found a blank picture after stop/restart when the previously inactive stream was reused. Ignore rejected play requests for streams that have already been replaced.

The existing H.264/VP8 video negotiation and WebRTC audio negotiation remain in place. These changes address concrete failure paths; they do not establish the cause of the reported Hot Player/Stream Team silence without device measurements.

## Automated checks

`Audio browser compatibility` runs the server harness and a real WebRTC audio/video session from Chromium to Chromium, Firefox and WebKit. The Android bridge is simulated with a canvas and oscillator. The test requires received audio energy, rendered video, recovery from a refused play request, unmuted playback after a user gesture, and a fresh session after sharing restarts. Both test browsers use local ICE with no public STUN/TURN dependency. This does not verify cross-network relay, Android playback capture, audio hardware, lip sync, or actual Safari/iPhone devices.

Local command, after installing Playwright and browser engines and starting the dev server:

```sh
cd server
node --import ./test/register.mjs test/devserver.mjs 8788
# In another terminal; choose chromium, firefox or webkit:
BOXXIE_BROWSER=firefox node test/e2e_audio.cjs
```

The isolated Android CI workflow builds the APK without publishing a production release. Its app URL points to the existing production website; the viewer button change requires the updated website to be deployed after review. Installing the APK alone does not install the website changes. CI uses a temporary debug signing key: replacing an installation signed with a different key may require uninstalling the old app, which clears its local sign-in state.

## Physical-device acceptance

For each target receiver, record its model, OS/browser, host APK version, network and source player. Test:

1. The sender's test tone: audible remotely, on two receivers concurrently.
2. An owned, unprotected local video with a visible clap or sync marker: sound and picture remain aligned over a sustained session.
3. Hot Player and The Stream Team using media the tester is authorised to share. Compare captured PCM, outgoing PCM and incoming audio energy against the local-video control.
4. Join late; stop/restart sharing; background/foreground the receiver; reconnect after Wi-Fi interruption; deny then grant audio permission; change audio output.
5. Home Wi-Fi and a receiver on another network, confirming direct and TURN-relayed sessions.
6. Room approval, paired-phone controls, chat and video calls still work without film/call echo.

Do not mark a platform supported until these pass on representative real devices. If the tone works but a source player supplies silent PCM while the control video works, investigate the player's audio settings and capture policy. Android requires the source app to permit playback capture; receiver changes cannot override that policy. Use an authorised local file or individual playback with shared controls/call when capture is unavailable.

Reference: https://developer.android.com/media/platform/av-capture
