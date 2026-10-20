package com.freeview.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground "media playback" service. While it runs, Android treats the app
 * like a music player: it is not frozen in the background, the CPU and Wi-Fi
 * stay awake with the screen off, and a media notification + lock-screen
 * controls are shown.
 *
 * Swiping the app away from Recents calls onTaskRemoved(), which kills the
 * whole process so playback stops.
 */
public class PlaybackService extends Service {

    static final String ACTION_UPDATE = "com.freeview.app.UPDATE";
    static final String ACTION_PLAY   = "com.freeview.app.PLAY";
    static final String ACTION_PAUSE  = "com.freeview.app.PAUSE";
    static final String ACTION_CLOSE  = "com.freeview.app.CLOSE";
    static final String EXTRA_TITLE   = "title";
    static final String EXTRA_PLAYING = "playing";

    private static final String CHANNEL_ID = "playback";
    private static final int NOTIFICATION_ID = 1;
    /** Re-armed on every play/pause update; only a safety net against leaks. */
    private static final long WAKE_LOCK_TIMEOUT_MS = 6 * 60 * 60_000L;

    /** Implemented by MainActivity: forwards play/pause to the web player. */
    interface Controller {
        void play();
        void pause();
        void close();
    }

    static volatile Controller controller;
    static volatile boolean running;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String title = "";
    private boolean playing;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;

        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(getString(R.string.channel_desc));
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);

        session = new MediaSession(this, "FreeView");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay()  { Controller c = controller; if (c != null) c.play(); }
            @Override public void onPause() { Controller c = controller; if (c != null) c.pause(); }
            @Override public void onStop()  { Controller c = controller; if (c != null) c.pause(); }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);

        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FreeView:playback");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "FreeView:playback");
        wifiLock.setReferenceCounted(false);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Controller c = controller;

        if (ACTION_PLAY.equals(action)) {
            if (c != null) c.play();
        } else if (ACTION_PAUSE.equals(action)) {
            if (c != null) c.pause();
        } else if (ACTION_CLOSE.equals(action)) {
            if (c != null) c.close();
            shutdown();
            return START_NOT_STICKY;
        } else if (ACTION_UPDATE.equals(action)) {
            String t = intent.getStringExtra(EXTRA_TITLE);
            if (t != null && !t.isEmpty()) title = t;
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
        }

        updateSession();
        Notification n = buildNotification();
        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        updateLocks();
        return START_NOT_STICKY;
    }

    private void updateSession() {
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.isEmpty() ? getString(R.string.app_name) : title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, getString(R.string.app_name))
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                        | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());
    }

    private void updateLocks() {
        if (playing) {
            wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
            if (!wifiLock.isHeld()) wifiLock.acquire();
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock.isHeld()) wifiLock.release();
        }
    }

    private Notification buildNotification() {
        Notification.Action toggle = playing
                ? action(R.drawable.ic_pause, R.string.pause, ACTION_PAUSE, 1)
                : action(R.drawable.ic_play, R.string.play, ACTION_PLAY, 2);
        Notification.Action close = action(R.drawable.ic_close, R.string.close, ACTION_CLOSE, 3);

        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title.isEmpty() ? getString(R.string.app_name) : title)
                .setContentText(getString(R.string.now_playing))
                .setContentIntent(openAppIntent())
                .setOngoing(playing)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .addAction(toggle)
                .addAction(close)
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1))
                .build();
    }

    private Notification.Action action(int icon, int label, String act, int requestCode) {
        Intent i = new Intent(this, PlaybackService.class).setAction(act);
        PendingIntent pi = PendingIntent.getService(this, requestCode, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), getString(label), pi).build();
    }

    private PendingIntent openAppIntent() {
        Intent i = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(this, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void shutdown() {
        if (wakeLock.isHeld()) wakeLock.release();
        if (wifiLock.isHeld()) wifiLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** App swiped away from Recents: stop playback by ending the process. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdown();
        android.os.Process.killProcess(android.os.Process.myPid());
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock.isHeld()) wakeLock.release();
        if (wifiLock.isHeld()) wifiLock.release();
        session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
