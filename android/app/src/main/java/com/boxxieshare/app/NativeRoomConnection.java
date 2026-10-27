package com.boxxieshare.app;

import org.json.JSONObject;
import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Host signalling owned by Android, never by a WebView timer. No credentials are persisted/logged. */
final class NativeRoomConnection {
    interface Listener {
        void message(String id, JSONObject message);
        void state(String id, String state, int code, String reason);
    }
    private final HttpUrl base;
    private final String origin;
    private final Listener listener;
    private final OkHttpClient client;
    private final ScheduledExecutorService loop = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> retry, heartbeat;
    private Call ticketCall;
    private WebSocket socket;
    private String id = "", room = "", hostToken = "", sessionToken = "";
    private JSONObject welcome, roster, ending;
    private boolean active, opened;
    private long generation, lastHeard;
    private int attempts;
    private final long retryMs, heartbeatMs;

    NativeRoomConnection(String server, String origin, Listener listener) {
        this(server, origin, listener, 1000, 25000);
    }
    // Shorter clocks are used only by local JVM network tests.
    NativeRoomConnection(String server, String origin, Listener listener, long retryMs, long heartbeatMs) {
        this.base = HttpUrl.get(server);
        this.origin = origin;
        this.listener = listener;
        this.retryMs = retryMs;
        this.heartbeatMs = heartbeatMs;
        client = new OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS).writeTimeout(10, TimeUnit.SECONDS)
                .callTimeout(10, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS)
                .followRedirects(false).followSslRedirects(false).build();
    }

    private void post(Runnable task) {
        try { loop.execute(task); } catch (java.util.concurrent.RejectedExecutionException ignored) {}
    }

    void start(String connectionId, String code, String secret, String bearer) {
        post(() -> {
            if (active && room.equals(code) && hostToken.equals(secret) && sessionToken.equals(bearer)) {
                id = connectionId; // A recreated page attaches to the existing native connection.
                listener.state(id, opened ? "open" : "retrying", 0, "");
                if (opened) {
                    if (welcome != null) listener.message(id, welcome);
                    if (roster != null) listener.message(id, roster);
                    if (ending != null) listener.message(id, ending);
                }
                return;
            }
            clear();
            id = connectionId; room = code; hostToken = secret; sessionToken = bearer;
            active = true; attempts = 0;
            connect();
        });
    }

    private void connect() {
        if (!active) return;
        final long epoch = ++generation;
        Request request = new Request.Builder().url(base.resolve("/api/ticket"))
                .header("Origin", origin).header("Authorization", "Bearer " + sessionToken)
                .post(RequestBody.create(new byte[0], null)).build();
        ticketCall = client.newCall(request);
        ticketCall.enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException error) { post(() -> failed(epoch)); }
            @Override public void onResponse(Call call, Response response) {
                String ticket = "";
                final int status = response.code();
                try (Response r = response) {
                    if (r.isSuccessful() && r.body() != null) ticket = new JSONObject(r.body().string()).optString("ticket");
                } catch (Exception ignored) {}
                final String value = ticket;
                post(() -> {
                    if (!current(epoch)) return;
                    ticketCall = null;
                    if (status == 401 || status == 403) { refuse(status == 401 ? "signed_out" : "origin_not_allowed"); return; }
                    if (value.isEmpty()) { failed(epoch); return; }
                    open(epoch, value);
                });
            }
        });
    }

    private void open(long epoch, String ticket) {
        HttpUrl url = base.newBuilder().encodedPath("/api/rooms/" + room + "/ws")
                .addQueryParameter("ticket", ticket).addQueryParameter("role", "host")
                .addQueryParameter("token", hostToken).build();
        socket = client.newWebSocket(new Request.Builder().url(url).header("Origin", origin).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                post(() -> {
                    if (!current(epoch)) { ws.cancel(); return; }
                    opened = true; lastHeard = System.nanoTime();
                    listener.state(id, "open", 0, "");
                    heartbeat = loop.scheduleAtFixedRate(() -> {
                        if (!current(epoch)) return;
                        if (System.nanoTime() - lastHeard > TimeUnit.MILLISECONDS.toNanos(heartbeatMs * 3)) failed(epoch);
                        else if (!ws.send("{\"type\":\"ping\"}")) failed(epoch);
                    }, heartbeatMs, heartbeatMs, TimeUnit.MILLISECONDS);
                });
            }
            @Override public void onMessage(WebSocket ws, String text) {
                post(() -> {
                    if (!current(epoch)) return;
                    lastHeard = System.nanoTime();
                    try {
                        JSONObject m = new JSONObject(text);
                        String type = m.optString("type");
                        if (type.equals("welcome")) { attempts = 0; welcome = m; }
                        if (type.equals("roster")) roster = m;
                        if (type.equals("ending")) ending = m;
                        listener.message(id, m);
                        if (type.equals("room-closed")) terminal(4004, m.optString("reason", "unknown"));
                        else if (type.equals("refused")) terminal(4003, m.optString("error", "not_host"));
                    } catch (Exception ignored) {}
                });
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, "");
                post(() -> closed(epoch, code, reason));
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) { post(() -> closed(epoch, code, reason)); }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) { post(() -> failed(epoch)); }
        });
    }

    private boolean current(long epoch) { return active && epoch == generation; }
    private void closed(long epoch, int code, String reason) {
        if (!current(epoch)) return;
        if (code == 4000 || code == 4003 || code == 4004) terminal(code, reason);
        else failed(epoch);
    }
    private void failed(long epoch) {
        if (!current(epoch)) return;
        ++generation; // Ignore all callbacks from the cancelled ticket/socket.
        cancelTransport(false);
        listener.state(id, "retrying", 0, "network");
        long wait = Math.min(5000, retryMs * (1L << Math.min(attempts++, 3)));
        retry = loop.schedule(this::connect, wait, TimeUnit.MILLISECONDS);
    }
    private void refuse(String reason) {
        try { listener.message(id, new JSONObject().put("type", "refused").put("error", reason)); } catch (Exception ignored) {}
        terminal(4003, reason);
    }
    private void terminal(int code, String reason) {
        String target = id;
        clear();
        listener.state(target, "closed", code, reason);
    }
    void send(String connectionId, String json) {
        post(() -> {
            if (active && id.equals(connectionId) && opened && socket != null && !socket.send(json)) failed(generation);
        });
    }
    void stop(String connectionId) {
        post(() -> { if (id.equals(connectionId)) clear(); });
    }
    private void cancelTransport(boolean graceful) {
        opened = false;
        if (heartbeat != null) heartbeat.cancel(false);
        heartbeat = null;
        if (ticketCall != null) ticketCall.cancel();
        ticketCall = null;
        if (socket != null) {
            if (graceful) socket.close(1000, "leaving");
            else socket.cancel();
        }
        socket = null;
    }
    private void clear() {
        active = false; ++generation;
        if (retry != null) retry.cancel(false);
        retry = null;
        cancelTransport(true);
        room = hostToken = sessionToken = "";
        welcome = roster = ending = null;
    }
    // Test cleanup only. The production instance lives with the capture engine.
    void dispose() {
        post(() -> { clear(); client.dispatcher().executorService().shutdown(); client.connectionPool().evictAll(); loop.shutdown(); });
    }
}
