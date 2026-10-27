package com.boxxieshare.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class VideoQualityProfileTest {
    @Test public void directlyNegotiatedVP8GetsAutoBudgetWithoutAFallbackRestart() {
        VideoQualityProfile p = VideoQualityProfile.forCodec(true, 1080, 4_000_000, false, "vp8");
        assertEquals(720, p.height);
        assertEquals(2_500_000, p.bitrate);
        assertEquals(24, p.fps);
        assertEquals(1080, VideoQualityProfile.forCodec(true, 1080, 4_000_000, false, "H264").height);
    }
    @Test public void autoCannotTurnInto4kOrExceedUploadCeiling() {
        VideoQualityProfile p = new VideoQualityProfile(true, 2160, 25_000_000, false);
        assertTrue(p.automatic);
        assertEquals(1080, p.height);
        assertEquals(8_000_000, p.bitrate);
        assertEquals(30, p.fps);
    }
    @Test public void fallbackKeepsAConservativeEncoderBudget() {
        for (boolean automatic : new boolean[]{true, false}) {
            VideoQualityProfile p = new VideoQualityProfile(automatic, 2160, 25_000_000, true);
            assertEquals(720, p.height);
            assertEquals(2_500_000, p.bitrate);
            assertEquals(24, p.fps);
        }
    }
    @Test public void lowerRequestedLimitsStayLower() {
        VideoQualityProfile p = new VideoQualityProfile(true, 540, 800_000, true);
        assertEquals(540, p.height);
        assertEquals(800_000, p.bitrate);
    }
    @Test public void receiverDisplayGetsItsOwnAutoBudgetAndManualStillWins() {
        VideoQualityProfile phone = VideoQualityProfile.forReceiver(true, 1080, 8_000_000, false, "H264", 720);
        assertEquals(720, phone.height);
        assertEquals(4_000_000, phone.bitrate);
        VideoQualityProfile tv = VideoQualityProfile.forReceiver(true, 1080, 8_000_000, false, "H264", 1080);
        assertEquals(1080, tv.height);
        assertEquals(8_000_000, tv.bitrate);
        VideoQualityProfile vp8 = VideoQualityProfile.forReceiver(true, 1080, 8_000_000, false, "VP8", 1080);
        assertEquals(720, vp8.height);
        assertEquals(2_500_000, vp8.bitrate);
        VideoQualityProfile manual = VideoQualityProfile.forReceiver(false, 2160, 25_000_000, false, "H264", 720);
        assertEquals(2160, manual.height);
        assertEquals(25_000_000, manual.bitrate);
    }
    @Test public void manual4kRemainsAvailableAndInvalidInputsHaveDefaults() {
        VideoQualityProfile manual = new VideoQualityProfile(false, 2160, 25_000_000, false);
        assertEquals(2160, manual.height);
        assertEquals(25_000_000, manual.bitrate);
        VideoQualityProfile auto = new VideoQualityProfile(true, 0, -1, false);
        assertEquals(1080, auto.height);
        assertEquals(4_000_000, auto.bitrate);
    }
}
