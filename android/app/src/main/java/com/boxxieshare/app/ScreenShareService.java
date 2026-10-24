package com.boxxieshare.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

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
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        Intent permission = intent == null ? null : intent.getParcelableExtra(EXTRA_PERMISSION);
        if (permission != null) ScreenShareEngine.get(this).startCapture(permission);
        else stopSelf();
        return START_NOT_STICKY;
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
