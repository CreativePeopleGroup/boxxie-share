package com.boxxieshare.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpParameters;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Shares the whole device screen (and, on Android 10+, the sound of other apps) with each
 * friend in the room, while Boxxie Share runs in the background.
 *
 * The web page stays in charge of the room. It hands each viewer to this engine, and the
 * engine's offers/answers travel over the page's normal signalling as {ch:"screen"} messages
 * (see web/app.js, "Android app: whole-screen sharing"). One sending-only connection per viewer.
 */
public final class ScreenShareEngine {
    private static final String TAG = "BoxxieScreen";

    public interface Listener {
        void onEvent(String json);
    }

    private static ScreenShareEngine instance;

    public static synchronized ScreenShareEngine get(Context ctx) {
        if (instance == null) instance = new ScreenShareEngine(ctx.getApplicationContext());
        return instance;
    }

    private final Context app;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile Listener listener;

    private EglBase egl;
    private PeerConnectionFactory factory;
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper textureHelper;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private AudioSource audioSource;
    private AudioTrack audioTrack;
    private AudioRecord playbackRecord;
    private ByteBuffer playbackScratch;
    private volatile boolean sharing;
    private String session;

    private final List<PeerConnection.IceServer> iceServers = new ArrayList<>();
    private int maxBitrate = 8_000_000;
    private int maxHeight = 1080;
    private final Map<String, Viewer> viewers = new HashMap<>();

    private static final class Viewer {
        PeerConnection pc;
        boolean remoteSet;
        final List<IceCandidate> pending = new ArrayList<>();
    }

    private ScreenShareEngine(Context app) {
        this.app = app;
    }

    public void setListener(Listener l) {
        listener = l;
    }

    public boolean isSharing() {
        return sharing;
    }

    // ------------------------------------------------------------------ setup

    private void ensureFactory() {
        if (factory != null) return;
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app)
                .createInitializationOptions());
        egl = EglBase.create();
        JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                // What the friends hear is the sound of the apps on this device, not the microphone.
                .setAudioBufferCallback((buffer, audioFormat, channelCount, sampleRate, bytesRead, captureTimeNs) -> {
                    fillWithPlayback(buffer, channelCount, sampleRate, bytesRead);
                    return captureTimeNs;
                })
                .setAudioRecordErrorCallback(new JavaAudioDeviceModule.AudioRecordErrorCallback() {
                    @Override public void onWebRtcAudioRecordInitError(String e) { soundUnavailable(e); }
                    @Override public void onWebRtcAudioRecordStartError(JavaAudioDeviceModule.AudioRecordStartErrorCode c, String e) { soundUnavailable(e); }
                    @Override public void onWebRtcAudioRecordError(String e) { soundUnavailable(e); }
                })
                .createAudioDeviceModule();
        factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
                .createPeerConnectionFactory();
    }

    private void soundUnavailable(String why) {
        Log.w(TAG, "sound: " + why);
        emit(safe(event("error"), "message", "This device can share the picture but not the sound."));
    }

    /** Settings from the page: ICE servers and picture quality. Safe to call any time. */
    public void configure(String json) {
        worker.execute(() -> {
            try {
                JSONObject o = new JSONObject(json);
                if (o.has("iceServers")) setIce(o.getJSONArray("iceServers"));
                JSONObject q = o.optJSONObject("quality");
                if (q != null) {
                    maxBitrate = q.optInt("maxBitrate", maxBitrate);
                    maxHeight = q.optInt("height", maxHeight);
                }
            } catch (Exception e) {
                Log.w(TAG, "configure", e);
            }
        });
    }

    public void setIceServers(String json) {
        worker.execute(() -> {
            try {
                setIce(new JSONArray(json));
            } catch (Exception e) {
                Log.w(TAG, "ice", e);
            }
        });
    }

    private void setIce(JSONArray arr) throws Exception {
        iceServers.clear();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject s = arr.getJSONObject(i);
            List<String> urls = new ArrayList<>();
            Object u = s.opt("urls");
            if (u instanceof JSONArray) {
                for (int j = 0; j < ((JSONArray) u).length(); j++) urls.add(((JSONArray) u).getString(j));
            } else if (u != null) {
                urls.add(u.toString());
            }
            if (urls.isEmpty()) continue;
            PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
            if (s.has("username")) b.setUsername(s.getString("username"));
            if (s.has("credential")) b.setPassword(s.getString("credential"));
            iceServers.add(b.createIceServer());
        }
    }

    // ------------------------------------------------------------------ capture

    /** Called by ScreenShareService once it is in the foreground (Android 14 requires that order). */
    public void startCapture(Intent permission) {
        worker.execute(() -> {
            try {
                ensureFactory();
                stopCaptureInternal(false);
                session = UUID.randomUUID().toString().substring(0, 8);

                capturer = new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
                    @Override
                    public void onStop() {
                        // The person stopped it from the system (notification, quick setting, pop-up).
                        worker.execute(() -> {
                            if (sharing) stopCaptureInternal(true);
                        });
                    }
                });
                textureHelper = SurfaceTextureHelper.create("BoxxieScreen", egl.getEglBaseContext());
                // Films, not slides: let the encoder trade sharpness for smooth motion when needed.
                videoSource = factory.createVideoSource(false);
                capturer.initialize(textureHelper, app, videoSource.getCapturerObserver());
                int[] size = captureSize();
                capturer.startCapture(size[0], size[1], 30);
                videoTrack = factory.createVideoTrack("screen-video", videoSource);

                boolean sound = startPlaybackCapture();
                audioSource = factory.createAudioSource(new MediaConstraints());
                audioTrack = factory.createAudioTrack("screen-audio", audioSource);
                audioTrack.setEnabled(sound);

                sharing = true;
                emit(event("started").put("audio", sound).put("width", size[0]).put("height", size[1]));
            } catch (Exception e) {
                Log.e(TAG, "start", e);
                sharing = false;
                emit(safe(event("error"), "message", "Couldn't start screen sharing on this device."));
                emit(event("denied"));
                ScreenShareService.stop(app);
            }
        });
    }

    /** The capture size: the real screen shape, no bigger than the chosen quality. */
    private int[] captureSize() {
        DisplayMetrics m = new DisplayMetrics();
        WindowManager wm = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
        if (wm != null) wm.getDefaultDisplay().getRealMetrics(m);
        int w = Math.max(m.widthPixels, 640), h = Math.max(m.heightPixels, 360);
        int longSide = Math.max(w, h), shortSide = Math.min(w, h);
        int limit = Math.min(shortSide, maxHeight);
        double scale = (double) limit / shortSide;
        int outW = (int) Math.round(w * scale) & ~1, outH = (int) Math.round(h * scale) & ~1;
        if (longSide * scale > 3840) {
            double s2 = 3840.0 / (longSide * scale);
            outW = (int) Math.round(outW * s2) & ~1;
            outH = (int) Math.round(outH * s2) & ~1;
        }
        return new int[]{outW, outH};
    }

    /** Android 10+: record the sound other apps are playing (apps can opt out; DRM apps do). */
    @SuppressLint("MissingPermission")
    private boolean startPlaybackCapture() {
        if (Build.VERSION.SDK_INT < 29 || capturer == null) return false;
        try {
            MediaProjection mp = capturer.getMediaProjection();
            if (mp == null) return false;
            AudioPlaybackCaptureConfiguration cfg = new AudioPlaybackCaptureConfiguration.Builder(mp)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();
            // Opened lazily in fillWithPlayback with the same rate/channels as the call audio.
            playbackConfig = cfg;
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "playback capture", t);
            return false;
        }
    }

    private Object playbackConfig; // AudioPlaybackCaptureConfiguration (API 29+)
    private int playbackRate, playbackChannels;

    @SuppressLint("MissingPermission")
    private void fillWithPlayback(ByteBuffer buffer, int channelCount, int sampleRate, int bytesRead) {
        if (!sharing || Build.VERSION.SDK_INT < 29 || playbackConfig == null) {
            zero(buffer, bytesRead);
            return;
        }
        try {
            if (playbackRecord == null || playbackRate != sampleRate || playbackChannels != channelCount) {
                releasePlayback();
                AudioFormat fmt = new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelCount == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO)
                        .build();
                int min = AudioRecord.getMinBufferSize(sampleRate,
                        channelCount == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT);
                playbackRecord = new AudioRecord.Builder()
                        .setAudioFormat(fmt)
                        .setBufferSizeInBytes(Math.max(min * 4, bytesRead * 8))
                        .setAudioPlaybackCaptureConfig((AudioPlaybackCaptureConfiguration) playbackConfig)
                        .build();
                playbackRecord.startRecording();
                playbackRate = sampleRate;
                playbackChannels = channelCount;
                playbackScratch = ByteBuffer.allocateDirect(Math.max(bytesRead, 4096));
            }
            if (playbackScratch.capacity() < bytesRead) playbackScratch = ByteBuffer.allocateDirect(bytesRead);
            playbackScratch.clear();
            int n = playbackRecord.read(playbackScratch, bytesRead, AudioRecord.READ_NON_BLOCKING);
            if (n < 0) n = 0;
            for (int i = 0; i < bytesRead; i++) buffer.put(i, i < n ? playbackScratch.get(i) : (byte) 0);
        } catch (Throwable t) {
            zero(buffer, bytesRead);
        }
    }

    private static void zero(ByteBuffer b, int n) {
        for (int i = 0; i < n; i++) b.put(i, (byte) 0);
    }

    private void releasePlayback() {
        if (playbackRecord != null) {
            try { playbackRecord.stop(); } catch (Throwable ignored) {}
            try { playbackRecord.release(); } catch (Throwable ignored) {}
            playbackRecord = null;
        }
    }

    // ------------------------------------------------------------------ viewers

    public void addViewer(String id) {
        worker.execute(() -> {
            if (!sharing || factory == null) return;
            closeViewer(id, false);
            PeerConnection.RTCConfiguration rtc = new PeerConnection.RTCConfiguration(new ArrayList<>(iceServers));
            rtc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            rtc.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
            rtc.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
            final Viewer v = new Viewer();
            PeerConnection pc = factory.createPeerConnection(rtc, new PeerObserver(id));
            if (pc == null) return;
            v.pc = pc;
            viewers.put(id, v);
            List<String> streams = Collections.singletonList("screen-" + session);
            RtpTransceiver vt = pc.addTransceiver(videoTrack,
                    new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, streams));
            pc.addTransceiver(audioTrack,
                    new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, streams));
            limitBitrate(vt.getSender());
            pc.createOffer(new SdpAdapter() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    final SessionDescription offer = new SessionDescription(sdp.type, preferH264(sdp.description));
                    worker.execute(() -> pc.setLocalDescription(new SdpAdapter() {
                        @Override
                        public void onSetSuccess() {
                            send(id, safe(new JSONObject(), "sdp", safe(safe(new JSONObject(), "type", "offer"), "sdp", offer.description)));
                        }
                    }, offer));
                }
            }, new MediaConstraints());
        });
    }

    private void limitBitrate(RtpSender sender) {
        try {
            RtpParameters p = sender.getParameters();
            for (RtpParameters.Encoding e : p.encodings) {
                e.maxBitrateBps = maxBitrate;
                e.maxFramerate = 30;
            }
            sender.setParameters(p);
        } catch (Throwable t) {
            Log.w(TAG, "bitrate", t);
        }
    }

    /** Messages from a viewer: their answer and network candidates. */
    public void signal(String id, String json) {
        worker.execute(() -> {
            Viewer v = viewers.get(id);
            if (v == null) return;
            try {
                JSONObject d = new JSONObject(json);
                if (d.has("session") && !d.optString("session").equals(session)) return;
                if (d.has("sdp")) {
                    JSONObject s = d.getJSONObject("sdp");
                    if (!"answer".equals(s.optString("type"))) return;
                    v.pc.setRemoteDescription(new SdpAdapter() {
                        @Override
                        public void onSetSuccess() {
                            worker.execute(() -> {
                                v.remoteSet = true;
                                for (IceCandidate c : v.pending) v.pc.addIceCandidate(c);
                                v.pending.clear();
                            });
                        }
                    }, new SessionDescription(SessionDescription.Type.ANSWER, s.getString("sdp")));
                } else if (d.has("candidate")) {
                    JSONObject c = d.getJSONObject("candidate");
                    String cand = c.optString("candidate", "");
                    if (cand.isEmpty()) return;
                    IceCandidate ic = new IceCandidate(c.optString("sdpMid", "0"), c.optInt("sdpMLineIndex", 0), cand);
                    if (v.remoteSet) v.pc.addIceCandidate(ic);
                    else v.pending.add(ic);
                }
            } catch (Exception e) {
                Log.w(TAG, "signal", e);
            }
        });
    }

    public void removeViewer(String id) {
        worker.execute(() -> closeViewer(id, false));
    }

    private void closeViewer(String id, boolean sayBye) {
        Viewer v = viewers.remove(id);
        if (v == null) return;
        if (sayBye) send(id, safe(new JSONObject(), "bye", true));
        try { v.pc.close(); } catch (Throwable ignored) {}
        try { v.pc.dispose(); } catch (Throwable ignored) {}
    }

    // ------------------------------------------------------------------ stop

    public void stop() {
        worker.execute(() -> stopCaptureInternal(true));
    }

    private void stopCaptureInternal(boolean announce) {
        boolean wasSharing = sharing;
        sharing = false;
        for (String id : new ArrayList<>(viewers.keySet())) closeViewer(id, true);
        releasePlayback();
        playbackConfig = null;
        if (capturer != null) {
            try { capturer.stopCapture(); } catch (Throwable ignored) {}
            try { capturer.dispose(); } catch (Throwable ignored) {}
            capturer = null;
        }
        if (videoTrack != null) { try { videoTrack.dispose(); } catch (Throwable ignored) {} videoTrack = null; }
        if (videoSource != null) { try { videoSource.dispose(); } catch (Throwable ignored) {} videoSource = null; }
        if (audioTrack != null) { try { audioTrack.dispose(); } catch (Throwable ignored) {} audioTrack = null; }
        if (audioSource != null) { try { audioSource.dispose(); } catch (Throwable ignored) {} audioSource = null; }
        if (textureHelper != null) { try { textureHelper.dispose(); } catch (Throwable ignored) {} textureHelper = null; }
        if (announce) {
            ScreenShareService.stop(app);
            if (wasSharing) emit(event("stopped"));
        }
    }

    // ------------------------------------------------------------------ helpers

    /** Put H.264 first: Fire TV and most phones have a hardware encoder for it. */
    static String preferH264(String sdp) {
        String[] lines = sdp.split("\r\n");
        List<String> h264 = new ArrayList<>();
        for (String l : lines) {
            if (l.startsWith("a=rtpmap:") && l.toUpperCase().contains(" H264/")) {
                h264.add(l.substring(9, l.indexOf(' ')));
            }
        }
        if (h264.isEmpty()) return sdp;
        StringBuilder out = new StringBuilder();
        for (String l : lines) {
            if (l.startsWith("m=video ")) {
                String[] p = l.split(" ");
                StringBuilder m = new StringBuilder(p[0] + " " + p[1] + " " + p[2]);
                for (String pt : h264) m.append(' ').append(pt);
                for (int i = 3; i < p.length; i++) if (!h264.contains(p[i])) m.append(' ').append(p[i]);
                l = m.toString();
            }
            out.append(l).append("\r\n");
        }
        return out.toString();
    }

    private void send(String peer, JSONObject data) {
        try {
            data.put("session", session);
            emit(event("signal").put("peer", peer).put("data", data));
        } catch (Exception ignored) {}
    }

    private static JSONObject safe(JSONObject o, String k, Object v) {
        try { o.put(k, v); } catch (Exception ignored) {}
        return o;
    }

    private static JSONObject event(String type) {
        return safe(new JSONObject(), "type", type);
    }

    void emit(JSONObject ev) {
        Listener l = listener;
        if (l != null) l.onEvent(ev.toString());
    }

    private class PeerObserver implements PeerConnection.Observer {
        private final String id;

        PeerObserver(String id) {
            this.id = id;
        }

        @Override
        public void onIceCandidate(IceCandidate c) {
            try {
                send(id, new JSONObject().put("candidate", new JSONObject()
                        .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)));
            } catch (Exception ignored) {}
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
        @Override public void onIceConnectionReceivingChange(boolean b) {}
        @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {}
        @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
        @Override public void onAddStream(MediaStream s) {}
        @Override public void onRemoveStream(MediaStream s) {}
        @Override public void onDataChannel(DataChannel d) {}
        @Override public void onRenegotiationNeeded() {}
        @Override public void onAddTrack(RtpReceiver r, MediaStream[] s) {}
    }

    /** SdpObserver with empty defaults; JSON errors inside callbacks are swallowed. */
    private abstract static class SdpAdapter implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sdp) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String e) { Log.w(TAG, "sdp create: " + e); }
        @Override public void onSetFailure(String e) { Log.w(TAG, "sdp set: " + e); }
    }
}
