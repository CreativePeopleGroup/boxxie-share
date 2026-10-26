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
