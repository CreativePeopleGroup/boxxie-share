package com.boxxieshare.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.media.projection.MediaProjectionManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Boxxie Share for Android TV, Fire TV and Android phones.
 *
 * A thin, locked-down shell around the Boxxie Share web app:
 *  - only ever shows the Boxxie Share site (other links open outside the app),
 *  - lets you pick your own video files (with a built-in list for TVs that have no file picker),
 *  - asks for camera/microphone only when you press "Join the call",
 *  - keeps the screen awake while you watch.
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK_FILE = 10;
    private static final int REQ_MEDIA_PERMISSION = 20;
    private static final int REQ_CALL_PERMISSION = 30;
    private static final int REQ_SCREEN = 40;
    private static final int REQ_SHARE_AUDIO = 50;

    /** True while the page showing is the Boxxie Share site (the JS bridge only answers it). */
    private volatile boolean ourPage;
    private ScreenShareEngine engine;
    private Updater updater;

    private WebView web;
    private FrameLayout root;
    private Uri appUri;

    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingWebPermission;

    private OnBackInvokedCallback backCallback;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        appUri = Uri.parse(BuildConfig.APP_URL);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#142130"));
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#142130"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfSystemBars();
        if (Build.VERSION.SDK_INT >= 33) {
            // Android 13+ (and required from Android 16): Back comes through this callback.
            backCallback = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }

        WebSettings s = web.getSettings();
        s.setTextZoom(100); // the page sizes itself to the TV; ignore the system text-size setting
        // While you watch another app, keep Boxxie's page (which lets friends in and connects them)
        // running: by default Android lets a hidden web page's process be killed to save memory.
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // needed to read the video you choose
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        s.setUserAgentString(s.getUserAgentString() + (isTv() ? " BoxxieShareTV/1" : " BoxxieShareApp/1"));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        web.setWebViewClient(new ShellClient());
        web.setWebChromeClient(new ShellChrome());

        // Whole-screen sharing for the page (phones, Android TV, Fire TV)
        engine = ScreenShareEngine.get(this);
        engine.setListener(json -> runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.boxxieNativeEvent && window.boxxieNativeEvent(" + org.json.JSONObject.quote(json) + ")", null);
        }));
        updater = new Updater(this, json -> runOnUiThread(() -> {
            if (web != null) web.evaluateJavascript("window.boxxieNativeEvent && window.boxxieNativeEvent(" + org.json.JSONObject.quote(json) + ")", null);
        }));
        web.addJavascriptInterface(new NativeBridge(), "BoxxieNative");
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);

        if (savedInstanceState != null && !savedInstanceState.getBoolean("freshPage")) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(BuildConfig.APP_URL);
        }
        web.requestFocus();
    }

    /**
     * Android 15+ draws apps edge to edge, under the status and navigation bars.
     * Pad the page so nothing hides behind them (or behind the keyboard). The film's own
     * full-screen mode hides the bars, so it still uses the whole screen.
     */
    private void keepClearOfSystemBars() {
        if (Build.VERSION.SDK_INT < 20) return;
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                l = i.left; t = i.top; r = i.right; b = i.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft(); t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight(); b = insets.getSystemWindowInsetBottom();
            }
            if (fullscreenView != null) { l = 0; t = 0; r = 0; b = 0; }
            v.setPadding(l, t, r, b);
            return insets;
        });
    }

    private boolean isTv() {
        UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        boolean tvMode = ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
        PackageManager pm = getPackageManager();
        return tvMode
                || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || pm.hasSystemFeature("amazon.hardware.fire_tv");
    }

    private boolean isOurSite(Uri u) {
        return u != null
                && "https".equals(u.getScheme())
                && appUri.getHost() != null
                && appUri.getHost().equalsIgnoreCase(u.getHost());
    }

    // ------------------------------------------------------------------ navigation

    private class ShellClient extends WebViewClient {
        /** If Android still stops the page (very low memory), rebuild it instead of crashing the app.
         *  Screen sharing keeps running in the background service; the page rejoins the room. */
        @Override
        public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            if (view != web) return true;
            runOnUiThread(() -> {
                try {
                    ((android.view.ViewGroup) web.getParent()).removeView(web);
                    web.destroy();
                } catch (Exception ignored) {}
                web = null;
                recreate();
            });
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            ourPage = url != null && isOurSite(Uri.parse(url));
            super.onPageStarted(view, url, favicon);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return handleUrl(request.getUrl());
        }

        @SuppressWarnings("deprecation")
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            return handleUrl(Uri.parse(url));
        }

        private boolean handleUrl(Uri u) {
            if (isOurSite(u)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, "Can't open that link on this device", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (Build.VERSION.SDK_INT < 23) showOffline();
        }
    }

    private void showOffline() {
        String html = "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<body style='margin:0;background:#142130;color:#f6f1ea;font:20px system-ui,sans-serif;"
                + "display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center'>"
                + "<div style='max-width:32em;padding:24px'><h2>Can't reach Boxxie Share</h2>"
                + "<p style='color:#b0bfd1'>Check this device is connected to the internet, then try again.</p>"
                + "<button autofocus onclick=\"location.href='" + BuildConfig.APP_URL + "'\" "
                + "style='font:inherit;font-weight:700;background:#e97684;color:#2a0f14;border:0;border-radius:8px;"
                + "padding:14px 28px;outline-offset:4px'>Try again</button></div>";
        web.loadDataWithBaseURL(BuildConfig.APP_URL, html, "text/html", "utf-8", null);
    }

    // ------------------------------------------------------------------ file picking, camera, full screen

    private class ShellChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            if (BuildConfig.LIST_DEVICE_VIDEOS && Build.VERSION.SDK_INT >= 23 && needsMediaPermission()) {
                requestPermissions(new String[]{mediaPermission()}, REQ_MEDIA_PERMISSION);
            } else {
                showVideoChooser();
            }
            return true;
        }

        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    handleWebPermission(request);
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (pendingWebPermission == request) pendingWebPermission = null;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreenView = view;
            fullscreenCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            setSystemBarsHidden(true);
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        web.setVisibility(View.VISIBLE);
        setSystemBarsHidden(false);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        web.requestFocus();
    }

    private void setSystemBarsHidden(boolean on) {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                if (on) {
                    c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    c.hide(WindowInsets.Type.systemBars());
                } else {
                    c.show(WindowInsets.Type.systemBars());
                }
            }
            root.requestApplyInsets();
            return;
        }
        int flags = on
                ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                  | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                : View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        getWindow().getDecorView().setSystemUiVisibility(flags);
        if (Build.VERSION.SDK_INT >= 20) root.requestApplyInsets();
    }

    private String mediaPermission() {
        return Build.VERSION.SDK_INT >= 33
                ? "android.permission.READ_MEDIA_VIDEO"
                : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    private boolean hasPermission(String p) {
        // Before Android 6 permissions are granted at install time.
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean needsMediaPermission() {
        if (!BuildConfig.LIST_DEVICE_VIDEOS) return true; // Play version never reads the video library
        return !hasPermission(mediaPermission());
    }

    private Intent systemPickerIntent() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("video/*");
        if (i.resolveActivity(getPackageManager()) != null) return i;
        Intent g = new Intent(Intent.ACTION_GET_CONTENT);
        g.addCategory(Intent.CATEGORY_OPENABLE);
        g.setType("video/*");
        if (g.resolveActivity(getPackageManager()) != null) return g;
        if (Build.VERSION.SDK_INT >= 33) {
            // Android's photo and video picker: no permission needed.
            Intent pp = new Intent(MediaStore.ACTION_PICK_IMAGES);
            pp.setType("video/*");
            if (pp.resolveActivity(getPackageManager()) != null) return pp;
        }
        return null;
    }

    /** Lists videos stored on this device (and USB drives on newer Android), newest first. */
    private void showVideoChooser() {
        final List<Uri> uris = new ArrayList<>();
        final List<String> labels = new ArrayList<>();
        final Intent picker = systemPickerIntent();
        if (picker != null) {
            uris.add(null);
            labels.add("Browse other folders…");
        }

        if (!needsMediaPermission()) {
            Uri collection = Build.VERSION.SDK_INT >= 29
                    ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                    : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            String[] cols = {MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME,
                    MediaStore.Video.Media.SIZE, MediaStore.Video.Media.DURATION};
            Cursor c = null;
            try {
                c = getContentResolver().query(collection, cols, null, null,
                        MediaStore.Video.Media.DATE_MODIFIED + " DESC");
                if (c != null) {
                    int idCol = c.getColumnIndexOrThrow(MediaStore.Video.Media._ID);
                    int nameCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME);
                    int sizeCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE);
                    int durCol = c.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION);
                    while (c.moveToNext() && uris.size() < 500) {
                        long id = c.getLong(idCol);
                        String name = c.getString(nameCol);
                        long size = c.getLong(sizeCol);
                        long dur = c.getLong(durCol);
                        uris.add(ContentUris.withAppendedId(collection, id));
                        labels.add((name == null ? "Video" : name) + "   " + describe(size, dur));
                    }
                }
            } catch (Exception e) {
                // fall through with whatever we found
            } finally {
                if (c != null) c.close();
            }
        }

        boolean onlyPicker = picker != null && uris.size() == 1;
        if (uris.isEmpty()) {
            Toast.makeText(this, BuildConfig.LIST_DEVICE_VIDEOS
                            ? "No videos found on this device. Copy a film onto it or plug in a USB drive."
                            : "This device has no file picker. Share from a phone or computer instead.",
                    Toast.LENGTH_LONG).show();
            finishFileChoice(null);
            return;
        }
        if (onlyPicker) {
            launchPicker(picker);
            return;
        }

        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle("Choose a film")
                .setItems(labels.toArray(new String[0]), (d, which) -> {
                    Uri chosen = uris.get(which);
                    if (chosen == null) launchPicker(picker);
                    else finishFileChoice(new Uri[]{chosen});
                })
                .setOnCancelListener(d -> finishFileChoice(null))
                .show();
    }

    private void launchPicker(Intent picker) {
        try {
            startActivityForResult(picker, REQ_PICK_FILE);
        } catch (ActivityNotFoundException e) {
            finishFileChoice(null);
        }
    }

    private static String describe(long bytes, long ms) {
        String size = bytes >= 1_000_000_000L
                ? String.format(Locale.UK, "%.1f GB", bytes / 1e9)
                : String.format(Locale.UK, "%d MB", Math.max(1, bytes / 1_000_000L));
        if (ms <= 0) return size;
        long mins = ms / 60000;
        return size + ", " + (mins >= 60 ? (mins / 60) + "h " + (mins % 60) + "m" : mins + "m");
    }

    private void finishFileChoice(Uri[] result) {
        if (fileCallback != null) fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SCREEN) {
            if (resultCode == RESULT_OK && data != null) {
                ScreenShareService.start(this, data);
            } else {
                engine.emit(eventJson("denied"));
            }
            return;
        }
        if (requestCode == REQ_PICK_FILE) {
            Uri u = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
            finishFileChoice(u == null ? null : new Uri[]{u});
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** The web page asked for camera/microphone (only when you press "Join the call"). */
    private void handleWebPermission(PermissionRequest request) {
        if (!isOurSite(request.getOrigin())) {
            request.deny();
            return;
        }
        List<String> needed = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) needed.add(Manifest.permission.CAMERA);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (needed.isEmpty()) {
            request.deny();
            return;
        }
        List<String> missing = new ArrayList<>();
        for (String p : needed) {
            if (!hasPermission(p)) missing.add(p);
        }
        if (missing.isEmpty() || Build.VERSION.SDK_INT < 23) {
            request.grant(request.getResources());
            return;
        }
        if (pendingWebPermission != null) pendingWebPermission.deny();
        pendingWebPermission = request;
        requestPermissions(missing.toArray(new String[0]), REQ_CALL_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_SHARE_AUDIO) {
            askToCaptureScreen(); // with or without sound
            return;
        }
        if (requestCode == REQ_MEDIA_PERMISSION) {
            showVideoChooser(); // shows the list if allowed, otherwise just the system picker
            return;
        }
        if (requestCode == REQ_CALL_PERMISSION && pendingWebPermission != null) {
            PermissionRequest req = pendingWebPermission;
            pendingWebPermission = null;
            List<String> grant = new ArrayList<>();
            for (String r : req.getResources()) {
                String p = PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) ? Manifest.permission.CAMERA
                        : PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) ? Manifest.permission.RECORD_AUDIO : null;
                if (p != null && hasPermission(p)) grant.add(r);
            }
            if (grant.isEmpty()) req.deny();
            else req.grant(grant.toArray(new String[0]));
        }
    }

    // ------------------------------------------------------------------ remote control

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Android 13+ delivers Back through the OnBackInvokedCallback instead.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK && Build.VERSION.SDK_INT < 33) {
            if (event.getAction() == KeyEvent.ACTION_UP) onBackPressed();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (fullscreenView != null) {
            exitFullscreen();
            return;
        }
        if (web == null) return;
        // Let the page decide (e.g. "Leave the room?") so Back never quits mid-film by accident.
        web.evaluateJavascript("(window.boxxieBack ? window.boxxieBack() : false)", value -> {
            if (!"true".equals(value)) {
                if (web != null && web.canGoBack()) web.goBack();
                else finish();
            }
        });
    }

    // ------------------------------------------------------------------ screen sharing

    private static org.json.JSONObject eventJson(String type) {
        org.json.JSONObject o = new org.json.JSONObject();
        try { o.put("type", type); } catch (Exception ignored) {}
        return o;
    }

    /** Sound from other apps needs the microphone permission (Android's rule), then the system pop-up. */
    private void beginScreenShare() {
        if (Build.VERSION.SDK_INT >= 29 && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_SHARE_AUDIO);
        } else {
            askToCaptureScreen();
        }
    }

    private void askToCaptureScreen() {
        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            engine.emit(eventJson("denied"));
            return;
        }
        try {
            startActivityForResult(mpm.createScreenCaptureIntent(), REQ_SCREEN);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "This device doesn't allow screen sharing", Toast.LENGTH_LONG).show();
            engine.emit(eventJson("denied"));
        }
    }

    /** What the page can call as window.BoxxieNative (only ever answered for the Boxxie Share site). */
    private class NativeBridge {
        @JavascriptInterface
        public String screenShareInfo() {
            org.json.JSONObject o = new org.json.JSONObject();
            try {
                o.put("available", ourPage && Build.VERSION.SDK_INT >= 21);
                o.put("audio", Build.VERSION.SDK_INT >= 29);
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("tv", isTv());
            } catch (Exception ignored) {}
            return o.toString();
        }

        @JavascriptInterface
        public void startScreenShare(String config) {
            if (!ourPage) return;
            engine.configure(config);
            runOnUiThread(MainActivity.this::beginScreenShare);
        }

        @JavascriptInterface
        public void setIceServers(String json) {
            if (ourPage) engine.setIceServers(json);
        }

        @JavascriptInterface
        public void addViewer(String id) {
            if (ourPage) engine.addViewer(id);
        }

        @JavascriptInterface
        public void signal(String id, String json) {
            if (ourPage) engine.signal(id, json);
        }

        @JavascriptInterface
        public void removeViewer(String id) {
            if (ourPage) engine.removeViewer(id);
        }

        @JavascriptInterface
        public void stopScreenShare() {
            if (ourPage) engine.stop();
        }

        /** App version, and whether this build can update itself (Fire TV / Downloader build). */
        @JavascriptInterface
        public String appInfo() {
            return updater.info();
        }

        /** Is the TV screen still being shared? (After the page reloads, it rejoins the room.) */
        @JavascriptInterface
        public boolean isSharing() {
            return engine != null && engine.isSharing();
        }

        /** Apps on this TV, for the "Open an app" list: [{pkg, label, icon (data URL)}]. */
        @JavascriptInterface
        public String listApps() {
            return AppList.json(MainActivity.this);
        }

        /** Open one of the TV's apps (sharing carries on in the background). */
        @JavascriptInterface
        public void launchApp(String pkg) {
            if (!ourPage || pkg == null) return;
            runOnUiThread(() -> {
                if (!AppList.launch(MainActivity.this, pkg)) {
                    Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    try { startActivity(home); } catch (Exception e) { moveTaskToBack(true); }
                }
            });
        }

        @JavascriptInterface
        public void checkUpdate() {
            if (ourPage) updater.check();
        }

        @JavascriptInterface
        public void installUpdate() {
            if (ourPage) updater.install();
        }

        /** "Open another app": go to the home screen, sharing carries on. */
        @JavascriptInterface
        public void goHome() {
            if (!ourPage) return;
            runOnUiThread(() -> {
                Intent home = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { startActivity(home); } catch (Exception e) { moveTaskToBack(true); }
            });
        }
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
        else outState.putBoolean("freshPage", true); // the page had stopped: load it again from scratch
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        // Keep sharing going if the screen saver kicks in; only pause when actually leaving.
        if (isFinishing() && web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (updater != null) updater.release();
        if (engine != null && isFinishing()) {
            engine.setListener(null);
            engine.stop();
        }
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }
}
