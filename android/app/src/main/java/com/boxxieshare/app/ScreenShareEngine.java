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
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.webrtc.RTCStats;
import org.webrtc.RTCStatsReport;

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
    private int captureHeight = 1080;
    private int maxHeight = 1080;
    private final Map<String, Viewer> viewers = new HashMap<>();

    private static final class Viewer {
        PeerConnection pc;
        boolean remoteSet;
        boolean vp8;            // switched to VP8 because the H.264 encoder produced no picture
        int noPictureChecks;    // connected, but no frames encoded yet
        String ice = "new";
        String sess;            // connection id the viewer echoes back (new one after a codec switch)
        final List<IceCandidate> pending = new ArrayList<>();
    }

    // Every few seconds: how each friend's connection is doing (shown on the TV, used for fallback)
    private final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> healthTask;

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
        // Never use the microphone here (Fire TV doesn't have one): the engine runs WebRTC's
        // "recording-less" mode and fillWithPlayback supplies the sound of the TV's apps instead.
        try {
            adm.getClass().getMethod("setAudioRecordEnabled", boolean.class).invoke(adm, false);
        } catch (Throwable t) {
            Log.w(TAG, "recordingless audio not available", t);
        }
        factory = PeerConnectionFactory.builder()
                .setAudioDeviceModule(adm)
                // Constrained-baseline H.264 (high profile off): decodes on every phone, iPhone and browser
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, false))
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
                captureHeight = Math.min(size[0], size[1]);
                capturer.startCapture(size[0], size[1], 30);
                videoTrack = factory.createVideoTrack("screen-video", videoSource);

                boolean sound = startPlaybackCapture();
                audioSource = factory.createAudioSource(new MediaConstraints());
                audioTrack = factory.createAudioTrack("screen-audio", audioSource);
                audioTrack.setEnabled(sound);

                sharing = true;
                startHealthChecks();
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

    // Recording-less mode calls us in a tight loop: we hand over exactly one 10 ms frame per call
    // and sleep until it's due, so the sound plays at real speed. A small buffer smooths out the
    // uneven way the captured sound arrives.
    private long nextFrameNs;
    private byte[] ring = new byte[0];
    private int ringFill;
    private byte[] readScratch = new byte[0];

    // "Test sound": a short beep sent to friends instead of the TV's sound (checks the sound path)
    private volatile long toneUntilNs;
    private double tonePhase;

    public void testTone() {
        toneUntilNs = System.nanoTime() + 3_000_000_000L;
    }

    private void fillTone(ByteBuffer buffer, int frame, int channelCount, int sampleRate) {
        int samples = frame / 2 / Math.max(1, channelCount);
        double step = 2 * Math.PI * 440.0 / sampleRate;
        for (int i = 0; i < samples; i++) {
            short v = (short) (Math.sin(tonePhase) * 9000);
            tonePhase += step;
            for (int c = 0; c < channelCount; c++) {
                int at = (i * channelCount + c) * 2;
                buffer.put(at, (byte) (v & 0xff));
                buffer.put(at + 1, (byte) ((v >> 8) & 0xff));
            }
        }
    }

    @SuppressLint("MissingPermission")
    private void fillWithPlayback(ByteBuffer buffer, int channelCount, int sampleRate, int bytesRead) {
        int frame = buffer.capacity();
        callbacks++;
        lastFormat = sampleRate + "Hz x" + channelCount;
        if (System.nanoTime() < toneUntilNs) {
            fillTone(buffer, frame, channelCount, sampleRate);
            outgoingPeak = pcmPeak(buffer, frame);
            pace();
            return;
        }
        try {
            if (sharing && Build.VERSION.SDK_INT >= 29 && playbackConfig != null) {
                if (app.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    audioState = "no-permission";
                    zero(buffer, frame);
                    pace();
                    return;
                }
                if (playbackRecord == null || playbackRate != sampleRate || playbackChannels != channelCount) {
                    releasePlayback();
                    int mask = channelCount == 2 ? AudioFormat.CHANNEL_IN_STEREO : AudioFormat.CHANNEL_IN_MONO;
                    AudioFormat fmt = new AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(sampleRate)
                            .setChannelMask(mask)
                            .build();
                    int min = AudioRecord.getMinBufferSize(sampleRate, mask, AudioFormat.ENCODING_PCM_16BIT);
                    playbackRecord = new AudioRecord.Builder()
                            .setAudioFormat(fmt)
                            .setBufferSizeInBytes(Math.max(min * 4, frame * 20))
                            .setAudioPlaybackCaptureConfig((AudioPlaybackCaptureConfiguration) playbackConfig)
                            .build();
                    playbackRecord.startRecording();
                    playbackRate = sampleRate;
                    playbackChannels = channelCount;
                    ring = new byte[frame * 12];
                    ringFill = 0;
                    readScratch = new byte[frame * 4];
                    Log.i(TAG, "playback capture started " + sampleRate + " Hz x" + channelCount);
                }
                // Take whatever has arrived (without waiting) into the ring
                int n = playbackRecord.read(readScratch, 0, Math.min(readScratch.length, ring.length - ringFill), AudioRecord.READ_NON_BLOCKING);
                if (n > 0) {
                    System.arraycopy(readScratch, 0, ring, ringFill, n);
                    ringFill += n;
                }
                long t = System.nanoTime();
                if (n > 0) {
                    bytesSeenNs = t;
                    capturedPcmBytes += n;
                    capturedPeak = pcmPeak(readScratch, n);
                }
                if (n > 0 && !isSilent(readScratch, n)) soundSeenNs = t;
                audioState = t - soundSeenNs < 5_000_000_000L ? "ok" : t - bytesSeenNs < 5_000_000_000L ? "silent" : "nodata";
                if (ringFill >= frame) {
                    buffer.clear();
                    buffer.put(ring, 0, frame);
                    System.arraycopy(ring, frame, ring, 0, ringFill - frame);
                    ringFill -= frame;
                    // Too far behind (a hiccup): drop the backlog so the sound stays in step with the picture
                    if (ringFill > frame * 8) ringFill = 0;
                } else {
                    zero(buffer, frame);
                }
            } else {
                zero(buffer, frame);
            }
        } catch (Throwable t) {
            audioState = "error";
            captureError = t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage());
            Log.w(TAG, "playback capture", t);
            releasePlayback();
            zero(buffer, frame);
        }
        outgoingPeak = pcmPeak(buffer, frame);
        pace();
    }

    private static int pcmPeak(byte[] data, int length) {
        int peak = 0;
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (short) ((data[i] & 0xff) | (data[i + 1] << 8));
            peak = Math.max(peak, Math.abs(sample));
        }
        return peak;
    }

    private static int pcmPeak(ByteBuffer data, int length) {
        int peak = 0;
        for (int i = 0; i + 1 < length; i += 2) {
            int sample = (short) ((data.get(i) & 0xff) | (data.get(i + 1) << 8));
            peak = Math.max(peak, Math.abs(sample));
        }
        return peak;
    }

    private volatile long soundSeenNs;
    private volatile long callbacks;          // how many 10 ms sound frames WebRTC has asked for
    private volatile String lastFormat = "";
    // What happened to the TV's sound: ok | silent | nodata | no-permission | error | none
    private volatile String audioState = "none";
    private volatile long bytesSeenNs;
    // Diagnostic counters: raw playback capture and the actual PCM handed to WebRTC.
    private volatile long capturedPcmBytes;
    private volatile int outgoingPeak;
    private volatile int capturedPeak;
    private volatile String captureError = "";

    private static boolean isSilent(byte[] b, int n) {
        for (int i = 0; i + 1 < n; i += 64) {
            int v = (short) ((b[i] & 0xff) | (b[i + 1] << 8));
            if (v > 64 || v < -64) return false;
        }
        return true;
    }

    private void pace() {
        long now = System.nanoTime();
        if (nextFrameNs == 0 || now - nextFrameNs > 200_000_000L) nextFrameNs = now;
        nextFrameNs += 10_000_000L;
        long wait = nextFrameNs - System.nanoTime();
        if (wait > 0) {
            try {
                Thread.sleep(wait / 1_000_000L, (int) (wait % 1_000_000L));
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
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
        worker.execute(() -> connectViewer(id, false));
    }

    private void connectViewer(String id, boolean vp8) {
        {
            if (!sharing || factory == null) return;
            closeViewer(id, false);
            PeerConnection.RTCConfiguration rtc = new PeerConnection.RTCConfiguration(new ArrayList<>(iceServers));
            rtc.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            rtc.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
            rtc.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
            final Viewer v = new Viewer();
            v.vp8 = vp8;
            v.sess = vp8 ? session + "-vp8" : session;
            PeerConnection pc = factory.createPeerConnection(rtc, new PeerObserver(id));
            if (pc == null) return;
            v.pc = pc;
            viewers.put(id, v);
            List<String> streams = Collections.singletonList("screen-" + session);
            RtpTransceiver vt = pc.addTransceiver(videoTrack,
                    new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, streams));
            pc.addTransceiver(audioTrack,
                    new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY, streams));
            limitBitrate(vt.getSender(), vp8);
            pc.createOffer(new SdpAdapter() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    final SessionDescription offer = new SessionDescription(sdp.type, preferCodec(sdp.description, v.vp8 ? "VP8" : "H264"));
                    worker.execute(() -> pc.setLocalDescription(new SdpAdapter() {
                        @Override
                        public void onSetSuccess() {
                            send(id, v.sess, safe(new JSONObject(), "sdp", safe(safe(new JSONObject(), "type", "offer"), "sdp", offer.description)));
                        }
                    }, offer));
                }
            }, new MediaConstraints());
        }
    }

    // ------------------------------------------------------------------ health

    private void startHealthChecks() {
        if (healthTask != null) healthTask.cancel(false);
        healthTask = ticker.scheduleAtFixedRate(() -> worker.execute(this::checkViewers), 3, 3, TimeUnit.SECONDS);
    }

    private void stopHealthChecks() {
        if (healthTask != null) healthTask.cancel(false);
        healthTask = null;
    }

    /** Report each friend's connection to the page, and switch a friend to VP8 if H.264 sends nothing. */
    private void checkViewers() {
        if (!sharing) return;
        try {
            emit(event("audio-health").put("audioState", audioState)
                    .put("capturedPcmBytes", capturedPcmBytes)
                    .put("capturedPeak", capturedPeak)
                    .put("outgoingPeak", outgoingPeak)
                    .put("captureError", captureError));
        } catch (Exception ignored) {}
        for (Map.Entry<String, Viewer> e : new ArrayList<>(viewers.entrySet())) {
            final String id = e.getKey();
            final Viewer v = e.getValue();
            try {
                v.pc.getStats(report -> worker.execute(() -> onStats(id, v, report)));
            } catch (Throwable ignored) {}
        }
    }

    private void onStats(String id, Viewer v, RTCStatsReport report) {
        if (viewers.get(id) != v) return;
        long frames = 0, bytes = 0;
        double fps = 0;
        String encoder = "", codec = "", limit = "";
        Map<String, RTCStats> all = report.getStatsMap();
        long audioBytes = 0;
        for (RTCStats st : all.values()) {
            if (!"outbound-rtp".equals(st.getType())) continue;
            Map<String, Object> m = st.getMembers();
            if ("audio".equals(String.valueOf(m.get("kind")))) {
                Object ab = m.get("bytesSent");
                if (ab instanceof Number) audioBytes += ((Number) ab).longValue();
                continue;
            }
            if (!"video".equals(String.valueOf(m.get("kind")))) continue;
            Object f = m.get("framesEncoded");
            Object b = m.get("bytesSent");
            if (f instanceof Number) frames += ((Number) f).longValue();
            if (b instanceof Number) bytes += ((Number) b).longValue();
            Object fr = m.get("framesPerSecond");
            if (fr instanceof Number) fps = ((Number) fr).doubleValue();
            Object ql = m.get("qualityLimitationReason");
            if (ql != null) limit = String.valueOf(ql);
            Object impl = m.get("encoderImplementation");
            if (impl != null) encoder = String.valueOf(impl);
            Object cid = m.get("codecId");
            if (cid != null && all.get(String.valueOf(cid)) != null) {
                Object mime = all.get(String.valueOf(cid)).getMembers().get("mimeType");
                if (mime != null) codec = String.valueOf(mime).replace("video/", "");
            }
        }
        boolean connected = "connected".equals(v.ice) || "completed".equals(v.ice);
        if (connected && frames == 0) v.noPictureChecks++;
        else v.noPictureChecks = 0;
        try {
            emit(event("viewer-stats").put("peer", id).put("ice", v.ice).put("frames", frames)
                    .put("bytes", bytes).put("codec", codec).put("encoder", encoder).put("vp8", v.vp8)
                    .put("sound", System.nanoTime() - soundSeenNs < 5_000_000_000L)
                    .put("fps", Math.round(fps)).put("limit", limit).put("audioBytes", audioBytes)
                    .put("audioState", audioState).put("audioFrames", callbacks).put("audioFormat", lastFormat)
                    .put("capturedPcmBytes", capturedPcmBytes).put("capturedPeak", capturedPeak)
                    .put("outgoingPeak", outgoingPeak).put("captureError", captureError));
        } catch (Exception ignored) {}
        // Connected for ~6 seconds and the H.264 encoder hasn't made a single frame: use VP8 instead.
        if (!v.vp8 && v.noPictureChecks >= 2) {
            Log.w(TAG, "no H.264 frames for " + id + "; switching to VP8");
            connectViewer(id, true);
        }
    }

    private void limitBitrate(RtpSender sender, boolean vp8) {
        try {
            RtpParameters p = sender.getParameters();
            for (RtpParameters.Encoding e : p.encodings) {
                if (vp8) {
                    // VP8 is encoded by the TV's processor (no hardware help): 720p at 24 fps keeps
                    // up on a Fire TV Stick while it's also playing the film.
                    e.maxBitrateBps = Math.min(maxBitrate, 2_500_000);
                    e.maxFramerate = 24;
                    if (captureHeight > 720) e.scaleResolutionDownBy = captureHeight / 720.0;
                } else {
                    e.maxBitrateBps = maxBitrate;
                    e.maxFramerate = 30;
                }
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
                if (d.has("session") && !d.optString("session").equals(v.sess)) return;
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
        if (sayBye) send(id, v.sess, safe(new JSONObject(), "bye", true));
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
        stopHealthChecks();
        capturedPcmBytes = 0;
        capturedPeak = 0;
        outgoingPeak = 0;
        captureError = "";
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

    /** Put one codec first. H.264: Fire TV and most phones have a hardware encoder for it.
     *  VP8: the fallback when the hardware encoder won't produce a picture. */
    static String preferCodec(String sdp, String name) {
        String[] lines = sdp.split("\r\n");
        List<String> h264 = new ArrayList<>();
        for (String l : lines) {
            if (l.startsWith("a=rtpmap:") && l.toUpperCase().contains(" " + name + "/")) {
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

    private void send(String peer, String sess, JSONObject data) {
        try {
            data.put("session", sess);
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
            Viewer v = viewers.get(id);
            String sess = v != null && v.sess != null ? v.sess : session;
            try {
                send(id, sess, new JSONObject().put("candidate", new JSONObject()
                        .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)));
            } catch (Exception ignored) {}
        }

        @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
        @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {
            final String state = s.name().toLowerCase();
            worker.execute(() -> {
                Viewer v = viewers.get(id);
                if (v != null) v.ice = state;
                try { emit(event("viewer-state").put("peer", id).put("ice", state)); } catch (Exception ignored) {}
            });
        }
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
