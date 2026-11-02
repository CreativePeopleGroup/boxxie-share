package com.boxxieshare.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class PictureHistoryTest {
    @Test public void retainsNewestSamplesWithoutWebViewAndBoundsMemory() {
        PictureHistory history = new PictureHistory();
        for (int i = 0; i < 150; i++) history.add("sample-" + i);
        assertEquals(120, history.snapshot().size());
        assertEquals("sample-30", history.snapshot().get(0));
        assertEquals("sample-149", history.snapshot().get(119));
        history.snapshot().clear();
        assertEquals(120, history.snapshot().size());
        history.clear();
        assertTrue(history.snapshot().isEmpty());
    }
}
