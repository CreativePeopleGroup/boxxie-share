package com.boxxieshare.app;

import org.json.JSONObject;
import org.junit.Test;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.Dispatcher;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import static org.junit.Assert.*;

public class NativeRoomConnectionTest {
    private static final String SECRET = "a".repeat(64), BEARER = "b".repeat(64);
    private static final class Events implements NativeRoomConnection.Listener {
        final BlockingQueue<String> states = new LinkedBlockingQueue<>();
        final BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        @Override public void state(String id, String state, int code, String reason) { states.add(id + ":" + state + ":" + code + ":" + reason); }
        @Override public void message(String id, JSONObject m) { messages.add(id + ":" + m.optString("type")); }
    }
    private static void await(BlockingQueue<String> queue, String expected) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(6);
        while (System.nanoTime() < end) {
            String value = queue.poll(100, TimeUnit.MILLISECONDS);
            if (expected.equals(value)) return;
        }
        fail("Missing event " + expected);
    }
    private static final class Backend extends Dispatcher {
        final AtomicInteger tickets = new AtomicInteger(), sockets = new AtomicInteger(), pings = new AtomicInteger();
        final AtomicReference<WebSocket> socket = new AtomicReference<>();
        final BlockingQueue<String> sent = new LinkedBlockingQueue<>();
        volatile int ticketStatus = 200;
        volatile boolean replyToPing = true;
        @Override public MockResponse dispatch(RecordedRequest r) {
            if (r.getPath().equals("/api/ticket")) {
                tickets.incrementAndGet();
                if (!("Bearer " + BEARER).equals(r.getHeader("Authorization")) || !"https://app.example".equals(r.getHeader("Origin"))) return new MockResponse().setResponseCode(403);
                return new MockResponse().setResponseCode(ticketStatus).setBody("{\"ticket\":\"one-use-" + tickets.get() + "\"}");
            }
            if (r.getPath().startsWith("/api/rooms/ABCDEFGH/ws?")) {
                if (!SECRET.equals(r.getRequestUrl().queryParameter("token"))) return new MockResponse().setResponseCode(403);
                sockets.incrementAndGet();
                return new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
                    @Override public void onOpen(WebSocket ws, Response response) {
                        socket.set(ws);
                        ws.send("{\"type\":\"welcome\",\"iceServers\":[]}");
                        ws.send("{\"type\":\"roster\",\"viewers\":[],\"pending\":[]}");
                    }
                    @Override public void onMessage(WebSocket ws, String text) {
                        if (text.equals("{\"type\":\"ping\"}")) { pings.incrementAndGet(); if (replyToPing) ws.send("{\"type\":\"pong\"}"); }
                        else sent.add(text);
                    }
                    @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, ""); }
                });
            }
            return new MockResponse().setResponseCode(404);
        }
    }
    @Test public void nativePingsRetryAndReattachWithoutAnyWebView() throws Exception {
        Backend backend = new Backend(); Events events = new Events();
        try (MockWebServer server = new MockWebServer()) {
            server.setDispatcher(backend); server.start();
            NativeRoomConnection room = new NativeRoomConnection(server.url("/").toString(), "https://app.example", events, 20, 40);
            try {
                room.start("first", "ABCDEFGH", SECRET, BEARER);
                await(events.messages, "first:welcome");
                await(events.messages, "first:pong");
                assertTrue(backend.pings.get() > 0);
                // A real socket close: recovery fetches a fresh one-use ticket.
                backend.socket.get().close(1012, "temporary restart");
                await(events.states, "first:retrying:0:network");
                await(events.messages, "first:welcome");
                assertEquals(2, backend.tickets.get());
                assertEquals(2, backend.sockets.get());
                room.start("recreated-page", "ABCDEFGH", SECRET, BEARER);
                await(events.messages, "recreated-page:welcome");
                await(events.messages, "recreated-page:roster");
                room.stop("first"); // A stale page cannot stop its replacement.
                await(events.messages, "recreated-page:pong");
                assertEquals(2, backend.sockets.get());
                room.send("recreated-page", "{\"type\":\"end\"}");
                room.stop("recreated-page");
                assertEquals("{\"type\":\"end\"}", backend.sent.poll(3, TimeUnit.SECONDS));
                Thread.sleep(180);
                assertEquals(2, backend.tickets.get());
            } finally { room.dispose(); }
        }
    }
    @Test public void expiredSignInStopsRatherThanRetryingOrReopening() throws Exception {
        Backend backend = new Backend(); backend.ticketStatus = 401; Events events = new Events();
        try (MockWebServer server = new MockWebServer()) {
            server.setDispatcher(backend); server.start();
            NativeRoomConnection room = new NativeRoomConnection(server.url("/").toString(), "https://app.example", events, 20, 40);
            try {
                room.start("expired", "ABCDEFGH", SECRET, BEARER);
                await(events.messages, "expired:refused");
                await(events.states, "expired:closed:4003:signed_out");
                Thread.sleep(150);
                assertEquals(1, backend.tickets.get());
                assertEquals(0, backend.sockets.get());
            } finally { room.dispose(); }
        }
    }
    @Test public void transientTicketFailureRetriesAndClosedRoomDoesNot() throws Exception {
        Backend backend = new Backend(); backend.ticketStatus = 503; Events events = new Events();
        try (MockWebServer server = new MockWebServer()) {
            server.setDispatcher(backend); server.start();
            NativeRoomConnection room = new NativeRoomConnection(server.url("/").toString(), "https://app.example", events, 20, 40);
            try {
                room.start("retry", "ABCDEFGH", SECRET, BEARER);
                await(events.states, "retry:retrying:0:network");
                backend.ticketStatus = 200;
                await(events.messages, "retry:welcome");
                backend.socket.get().send("{\"type\":\"room-closed\",\"reason\":\"host-left\"}");
                await(events.states, "retry:closed:4004:host-left");
                int count = backend.tickets.get();
                Thread.sleep(150);
                assertEquals(count, backend.tickets.get());
            } finally { room.dispose(); }
        }
    }
    @Test public void replacedHostIsTerminal() throws Exception {
        Backend backend = new Backend(); Events events = new Events();
        try (MockWebServer server = new MockWebServer()) {
            server.setDispatcher(backend); server.start();
            NativeRoomConnection room = new NativeRoomConnection(server.url("/").toString(), "https://app.example", events, 20, 40);
            try {
                room.start("owner", "ABCDEFGH", SECRET, BEARER);
                await(events.messages, "owner:welcome");
                backend.socket.get().close(4000, "replaced");
                await(events.states, "owner:closed:4000:replaced");
                Thread.sleep(150);
                assertEquals(1, backend.tickets.get());
            } finally { room.dispose(); }
        }
    }
    @Test public void silentSocketIsDetectedWithoutACloseCallback() throws Exception {
        Backend backend = new Backend(); backend.replyToPing = false; Events events = new Events();
        try (MockWebServer server = new MockWebServer()) {
            server.setDispatcher(backend); server.start();
            NativeRoomConnection room = new NativeRoomConnection(server.url("/").toString(), "https://app.example", events, 20, 40);
            try {
                room.start("silent", "ABCDEFGH", SECRET, BEARER);
                await(events.messages, "silent:welcome");
                await(events.states, "silent:retrying:0:network");
                backend.replyToPing = true;
                await(events.messages, "silent:welcome");
                await(events.messages, "silent:pong");
                assertTrue(backend.tickets.get() >= 2);
            } finally { room.dispose(); }
        }
    }
}
