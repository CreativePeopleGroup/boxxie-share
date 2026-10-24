package com.boxxieshare.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update for the Fire TV / Downloader build: checks version.json on the latest GitHub
 * release, downloads BoxxieShare.apk straight into Android's installer, and Android asks the
 * person to confirm. Turned off in the Google Play build (Play updates the app itself).
 */
final class Updater {
    interface Emit { void emit(String json); }

    private static final String ACTION_STATUS = "com.boxxieshare.app.UPDATE_STATUS";
    private final Activity act;
    private final Emit emit;
    private volatile boolean busy;
    private BroadcastReceiver receiver;

    Updater(Activity act, Emit emit) {
        this.act = act;
        this.emit = emit;
    }

    boolean enabled() {
        return BuildConfig.SELF_UPDATE && BuildConfig.UPDATE_URL.length() > 0 && Build.VERSION.SDK_INT >= 21;
    }

    String info() {
        JSONObject o = new JSONObject();
        try {
            o.put("code", BuildConfig.VERSION_CODE);
            o.put("name", BuildConfig.VERSION_NAME);
            o.put("canUpdate", enabled());
        } catch (Exception ignored) {}
        return o.toString();
    }

    private void send(String type, Object... kv) {
        JSONObject o = new JSONObject();
        try {
            o.put("type", type);
            for (int i = 0; i + 1 < kv.length; i += 2) o.put((String) kv[i], kv[i + 1]);
        } catch (Exception ignored) {}
        emit.emit(o.toString());
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true); // github.com -> objects.githubusercontent.com (both https)
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", "BoxxieShare-Updater");
        return c;
    }

    void check() {
        if (!enabled()) return;
        new Thread(() -> {
            try {
                HttpURLConnection c = open(BuildConfig.UPDATE_URL + "version.json?t=" + System.currentTimeMillis());
                if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
                StringBuilder sb = new StringBuilder();
                try (InputStream in = c.getInputStream()) {
                    byte[] b = new byte[4096];
                    int n;
                    while ((n = in.read(b)) > 0) sb.append(new String(b, 0, n, "UTF-8"));
                }
                JSONObject v = new JSONObject(sb.toString());
                int latest = v.optInt("versionCode", 0);
                send("update", "available", latest > BuildConfig.VERSION_CODE, "name", v.optString("versionName", ""), "current", BuildConfig.VERSION_NAME);
            } catch (Exception e) {
                send("update", "available", false, "failed", true, "current", BuildConfig.VERSION_NAME);
            }
        }, "boxxie-update-check").start();
    }

    void install() {
        if (!enabled() || busy) return;
        // Android 8+: the person allows this app to install apps once (Fire TV: Install unknown apps).
        if (Build.VERSION.SDK_INT >= 26 && !act.getPackageManager().canRequestPackageInstalls()) {
            send("update-permission");
            act.runOnUiThread(() -> {
                try {
                    act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + act.getPackageName())));
                } catch (Exception e) {
                    send("update-error", "message", "Allow Boxxie Share to install apps: Settings, My Fire TV, Developer options, Install unknown apps, Boxxie Share.");
                }
            });
            return;
        }
        busy = true;
        new Thread(this::download, "boxxie-update").start();
    }

    private void download() {
        PackageInstaller.Session session = null;
        try {
            PackageInstaller pi = act.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(act.getPackageName());
            int id = pi.createSession(params);
            session = pi.openSession(id);

            HttpURLConnection c = open(BuildConfig.UPDATE_URL + "BoxxieShare.apk");
            if (c.getResponseCode() != 200) throw new Exception("download failed (HTTP " + c.getResponseCode() + ")");
            long total = c.getContentLength();
            send("update-progress", "pct", 0);
            try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("base.apk", 0, total > 0 ? total : -1)) {
                byte[] b = new byte[64 * 1024];
                long done = 0;
                int n, lastPct = 0;
                while ((n = in.read(b)) > 0) {
                    out.write(b, 0, n);
                    done += n;
                    if (total > 0) {
                        int pct = (int) (done * 100 / total);
                        if (pct >= lastPct + 2) { lastPct = pct; send("update-progress", "pct", pct); }
                    }
                }
                session.fsync(out);
            }
            listen();
            Intent status = new Intent(ACTION_STATUS).setPackage(act.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(act, id, status, flags);
            send("update-progress", "pct", 100);
            session.commit(pending.getIntentSender());
            session.close();
            session = null;
        } catch (Exception e) {
            if (session != null) try { session.abandon(); } catch (Exception ignored) {}
            busy = false;
            send("update-error", "message", "Couldn't download the update. Check the internet connection and try again.");
        }
    }

    private void listen() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { act.startActivity(confirm); } catch (Exception ignored) {}
                    }
                    return;
                }
                busy = false;
                if (st == PackageInstaller.STATUS_SUCCESS) return; // Android restarts the app
                String msg;
                if (st == PackageInstaller.STATUS_FAILURE_ABORTED) msg = "Update cancelled.";
                else if (st == PackageInstaller.STATUS_FAILURE_CONFLICT || st == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE)
                    msg = "This version can't update over the one installed. Uninstall Boxxie Share once, then install it with Downloader code 1920999.";
                else if (st == PackageInstaller.STATUS_FAILURE_STORAGE) msg = "Not enough space on this device for the update.";
                else msg = "The update didn't install. Try again, or install it with Downloader code 1920999.";
                send("update-error", "message", msg, "status", st);
            }
        };
        IntentFilter f = new IntentFilter(ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        else act.registerReceiver(receiver, f);
    }

    void release() {
        if (receiver != null) try { act.unregisterReceiver(receiver); } catch (Exception ignored) {}
        receiver = null;
    }
}
