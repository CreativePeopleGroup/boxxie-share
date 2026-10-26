# Boxxie Share development audit

Reviewed 26 October 2026 against main commit `1cda9dc` and `origin/diagnostics-v1.0.16`.

## Intended result

A lightweight watch-together application for personal use. The immediate acceptance target from the existing project discussion is synchronised picture and audio from a Xiaomi TV Stick running Android TV 11 to iPhone Safari. Existing video sharing, accounts, room approval, chat, calls and paired-phone controls must continue working. Do not rebuild the application.

## Evidence and current state

- Existing implementation: Android Java host/capture module, browser viewer, and Cloudflare Worker signalling/account server.
- The local folder was empty; the existing public repository has now been cloned here.
- The server harness passed in this audit: `node --import ./test/register.mjs test/harness.mjs` from `server/`, using the bundled Node runtime. This exercises server logic in its test environment, not production services or real media hardware.
- GitHub Actions run 40251343693 successfully compiled the diagnostics branch at 00:51 UTC on 26 October (01:51 UK time). It is a diagnostic test APK, not evidence of working device audio.
- Main Android build run 40154593630 succeeded on 25 October. No new APK was built during this audit.
- The diagnostics branch adds PCM counters, level readings and an isolated build workflow. Its audio callback, playback-capture setup and buffering architecture remain the same as main.
- Local Android compilation is unavailable in the current setup: no usable Java runtime or Gradle installation was found. CI can build Android, but a build cannot establish that audio works on the target devices.

## Findings

### High: the audio failure has not been isolated or resolved

`ScreenShareEngine.java` already supplies Android playback-captured PCM through WebRTC's audio buffer callback. Recording-less operation is deliberately enabled through `setAudioRecordEnabled(false)`. The upstream m144 source contains this method and invokes the buffer callback even when there is no microphone recorder. Consequently, the absence of a microphone alone does not establish the cause of silence; replacing this architecture without evidence would be premature.

Required verification is a continuous chain: callback activity → nonzero captured PCM → nonzero outgoing PCM → outgoing audio RTP → incoming audio RTP and energy → audible iPhone playback. Use the existing test tone to separate playback capture from transport and Safari playback. Compare an owned, unprotected media file with the two reported player apps. A player returning silent capture and a broken WebRTC sender require different remedies. No target-device measurements were available during this audit.

### Medium: playback recorder lifetime crosses threads without a common lock

The audio callback creates, reads and releases `playbackRecord`; the worker also releases it during stop. A callback already inside its capture branch can overlap worker teardown. The volatile `sharing` flag does not protect an in-progress read or recorder creation. Serialise access to the recorder and its configuration, and test stop/restart while audio is active. This is a concrete lifecycle risk; it has not been established as the reported persistent-silence cause.

### Medium: software voice processing is not explicitly disabled for film audio

The ADM disables hardware echo cancellation and noise suppression, but the audio source is created with empty constraints. This does not explicitly request that WebRTC software voice processing be disabled. Check the pinned library's supported controls and configure playback audio appropriately. This is a fidelity/integration concern, not a proven explanation for total silence.

### Medium: test builds must remain distinct from production releases

The diagnostics workflow uploads an isolated APK. The main build workflow publishes a release and marks it latest. Keep experimental audio work in a test workflow until device verification succeeds. Its v1.0.16 label is explicitly set by the diagnostic workflow; production version labels come from the build workflow run number.

### Low: documentation contradicts implementation

The README describes native screen sharing both as implemented and as future work. It also says sound is available on Android 10+ without clearly stating capture depends on the source app allowing it. Update these claims when documenting verified behaviour. Store readiness claims likewise exceed what this audit tested.

## Completion criteria

1. Reproduce on Xiaomi Android TV 11 and iPhone Safari, recording installed APK version and whether the test tone is audible.
2. Confirm the complete audio chain with an owned, unprotected video; then compare the reported players using content the user is authorised to share.
3. Implement the correction supported by those measurements, including safe recorder teardown and appropriate audio processing configuration.
4. Compile an isolated test APK, rerun server checks, and check viewer playback, pairing, approval, reconnect and stop/restart.
5. Verify audible synchronised audio on the target devices and document any source-app capture restrictions. Do not bypass capture protections.
6. Only then promote a tested build and update the README with its supported behaviour.

## References

- Repository: https://github.com/CreativePeopleGroup/boxxie-share
- Diagnostic build: https://github.com/CreativePeopleGroup/boxxie-share/actions/runs/40251343693
- Main build: https://github.com/CreativePeopleGroup/boxxie-share/actions/runs/40154593630
- Upstream recording control: https://github.com/webrtc-sdk/webrtc/blob/m144_release/sdk/android/api/org/webrtc/audio/JavaAudioDeviceModule.java
- Upstream callback implementation: https://github.com/webrtc-sdk/webrtc/blob/m144_release/sdk/android/src/java/org/webrtc/audio/WebRtcAudioRecord.java

The upstream branch is supporting integration evidence; its current source is not a binary-level verification of every detail of the pinned 144.7559.15 dependency.
