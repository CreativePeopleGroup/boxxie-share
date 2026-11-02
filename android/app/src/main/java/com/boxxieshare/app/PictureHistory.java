package com.boxxieshare.app;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

/** Bounded in-memory samples; independent of WebView delivery and never written to disk. */
final class PictureHistory {
    private final ArrayDeque<String> samples = new ArrayDeque<>();
    synchronized void add(String sample) {
        if (samples.size() == 120) samples.removeFirst();
        samples.addLast(sample);
    }
    synchronized List<String> snapshot() { return new ArrayList<>(samples); }
    synchronized void clear() { samples.clear(); }
}
