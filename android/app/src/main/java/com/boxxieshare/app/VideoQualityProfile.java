package com.boxxieshare.app;

/** Ceilings for WebRTC's own congestion/resource adaptation, not a second rate controller. */
final class VideoQualityProfile {
    final boolean automatic;
    final int height, bitrate, fps;

    static VideoQualityProfile forCodec(boolean automatic, int height, int bitrate, boolean forcedVP8, String codec) {
        return new VideoQualityProfile(automatic, height, bitrate,
                forcedVP8 || (automatic && "VP8".equalsIgnoreCase(codec)));
    }

    VideoQualityProfile(boolean automatic, int requestedHeight, int requestedBitrate, boolean vp8) {
        this.automatic = automatic;
        int h = requestedHeight > 0 ? requestedHeight : 1080;
        int b = requestedBitrate > 0 ? requestedBitrate : automatic ? 4_000_000 : 8_000_000;
        if (automatic) {
            h = Math.min(h, 1080);
            b = Math.min(b, 4_000_000);
        }
        // Keep the existing conservative fallback for sticks encoding VP8.
        height = vp8 ? Math.min(h, 720) : h;
        bitrate = vp8 ? Math.min(b, 2_500_000) : b;
        fps = vp8 ? 24 : 30;
    }
}
