package com.boxxieshare.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * Keeps screen sharing running while you use other apps. Android requires a visible
 * "foreground service" for screen capture, and (Android 14+) it must be running before the
 * capture starts, so the engine is started from here.
 */
public class ScreenShareService extends Service {
    static final String EXTRA_PERMISSION = "permission";
    static final String ACTION_STOP = "com.boxxieshare.app.STOP_SHARING";
    private static final String CHANNEL = "sharing";
    private static final int NOTIFICATION_ID = 7;

    static int foregroundTypes(int sdk, boolean recordAudioGranted) {
        if (sdk < 29) return 0;
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
        // Android 11+ also gates AudioRecord on the recording capability when our
        // activity leaves the foreground. This type grants that capability; our
        // recorder still uses playback capture and never opens the microphone.
        if (sdk >= 30 && recordAudioGranted) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        return types;
    }

    static void start(Context ctx, Intent permission) {
        Intent i = new Intent(ctx, ScreenShareService.class).putExtra(EXTRA_PERMISSION, permission);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, ScreenShareService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            ScreenShareEngine.get(this).stop();
            stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                int types = foregroundTypes(Build.VERSION.SDK_INT,
                        checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
                try {
                    startForeground(NOTIFICATION_ID, n, types);
                } catch (SecurityException denied) {
                    if ((types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) == 0) throw denied;
                    // Android 14+ can refuse while-in-use access if the activity is
                    // no longer visible. Preserve picture sharing and explain the
                    // audio limitation instead of crashing or claiming sound works.
                    startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
                    emit("error", "Android didn't allow background sound recording. Return to Boxxie and start sharing again.");
                    Log.w("BoxxieShareService", "background recording capability denied", denied);
                }
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (RuntimeException denied) {
            Log.e("BoxxieShareService", "foreground sharing could not start", denied);
            emit("error", "Android couldn't start screen sharing. Return to Boxxie and try again.");
            emit("denied", "");
            stopSelf();
            return START_NOT_STICKY;
        }
        Intent permission = intent == null ? null : intent.getParcelableExtra(EXTRA_PERMISSION);
        if (permission != null) ScreenShareEngine.get(this).startCapture(permission);
        else stopSelf();
        return START_NOT_STICKY;
    }

    private void emit(String type, String message) {
        try {
            ScreenShareEngine.get(this).emit(new org.json.JSONObject().put("type", type).put("message", message));
        } catch (org.json.JSONException ignored) {}
    }

    private Notification buildNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shown while Boxxie Share is sharing your screen");
            nm.createNotificationChannel(ch);
        }
        int piFlags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), piFlags);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, ScreenShareService.class).setAction(ACTION_STOP), piFlags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Sharing your screen")
                .setContentText("Friends in your Boxxie Share room can see it")
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(0, "Stop sharing", stop).build());
        return b.build();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
