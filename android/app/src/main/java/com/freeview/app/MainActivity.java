package com.freeview.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;

@SuppressLint("RequiresFeature") // bridge only exists when WEB_MESSAGE_LISTENER is supported
public class MainActivity extends Activity implements PlaybackService.Controller {

    private static final String HOME_URL  = "https://freeview.onrender.com/";
    private static final String SITE_HOST = "freeview.onrender.com";

    /** Frames that get the visibility override and the native bridge. */
    private static final Set<String> ORIGINS = Set.of(
            "https://freeview.onrender.com",
            "https://www.youtube-nocookie.com",
            "https://www.youtube.com");

    /** A pause within this long after leaving the app is treated as YouTube
     *  pausing itself (not the user) and is undone. */
    private static final long AUTO_RESUME_WINDOW_MS = 5_000;

    private final Handler main = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private BgWebView web;
    private ProgressBar progress;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private JavaScriptReplyProxy playerProxy;
    private String title = "";
    private boolean playing;
    private boolean userPaused;
    private boolean inForeground;
    private long backgroundedAt;
    private boolean openAppSettingsOnResume;
    private int nightMode;

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.bg));

        web = new BgWebView(this);
        web.setBackgroundColor(getColor(R.color.bg));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(false);
        progress.setMax(100);
        progress.setProgressTintList(android.content.res.ColorStateList.valueOf(getColor(R.color.red)));
        root.addView(progress, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));

        setContentView(root);
        setupEdgeToEdge();
        setupWebView();
        setupBackHandling();

        PlaybackService.controller = this;
        nightMode = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) {
            web.loadUrl(HOME_URL);
        }

        requestNotificationPermission();
        main.postDelayed(this::maybeShowBackgroundSetup, 1500);
    }

    @Override
    protected void onStart() {
        super.onStart();
        inForeground = true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (openAppSettingsOnResume) {
            openAppSettingsOnResume = false;
            openAppDetails();
        }
    }

    // Deliberately do NOT call web.onPause()/pauseTimers(): the page must keep
    // running in the background for playback to continue.
    @Override
    protected void onStop() {
        super.onStop();
        inForeground = false;
        backgroundedAt = SystemClock.elapsedRealtime();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    /**
     * The phone switched between light and dark. WebView only picks up the new
     * prefers-color-scheme when the activity is recreated, so do that, but
     * never in the middle of playback (it would stop the video); in that case
     * the page keeps its current theme until the app is next opened.
     */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int mode = newConfig.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        if (mode != nightMode) {
            nightMode = mode;
            if (!playing && customView == null) recreate();
        }
    }

    /** Matches the status/navigation bars to the page background ("rgb(r, g, b)"). */
    private void applyPageColor(String css) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)").matcher(css == null ? "" : css);
        if (!m.find()) return;
        int r = Integer.parseInt(m.group(1)), g = Integer.parseInt(m.group(2)), b = Integer.parseInt(m.group(3));
        root.setBackgroundColor(Color.rgb(r, g, b));
        boolean light = (0.299 * r + 0.587 * g + 0.114 * b) > 160;
        WindowInsetsController c = getWindow().getInsetsController();
        if (c != null) {
            int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            c.setSystemBarsAppearance(light ? mask : 0, mask);
        }
    }

    @Override
    protected void onDestroy() {
        if (PlaybackService.controller == this) PlaybackService.controller = null;
        stopService(new Intent(this, PlaybackService.class));
        web.destroy();
        super.onDestroy();
    }

    // ─── WebView ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "FreeViewNative", ORIGINS, this::onBridgeMessage);
        }
        String script = readAsset("inject.js");
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, script, ORIGINS);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (SITE_HOST.equals(uri.getHost())) return false;
                // Anything else (e.g. "Watch on YouTube") opens outside the app.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Fallback for very old WebView versions without document-start scripts.
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
                        && url != null && url.startsWith(HOME_URL)) {
                    view.evaluateJavascript(script, null);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showOfflinePage(view);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The page's renderer was killed (usually low memory while in
                // the background). Rebuild the activity instead of crashing.
                recreate();
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                enterFullscreen(view, callback);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // Avoid WebView's grey placeholder before the video starts.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });
    }

    private void showOfflinePage(WebView view) {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{background:#0f0f0f;color:#f1f1f1;font-family:sans-serif;display:flex;"
                + "flex-direction:column;align-items:center;justify-content:center;height:90vh;text-align:center;padding:0 24px}"
                + "p{color:#aaa}button{margin-top:16px;padding:12px 28px;border:0;border-radius:8px;"
                + "background:#ff4444;color:#fff;font-size:16px}"
                + "@media (prefers-color-scheme: light){body{background:#fff;color:#0f0f0f}p{color:#606060}"
                + "button{background:#cc1f1f}}</style></head><body>"
                + "<h2>Can't reach FreeView</h2><p>Check your internet connection and try again.</p>"
                + "<button onclick=\"location.href='" + HOME_URL + "'\">Retry</button></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    // ─── Bridge (messages from inject.js) ────────────────────────────────────

    private void onBridgeMessage(WebView view, WebMessageCompat message, Uri sourceOrigin,
                                 boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        String data = message.getData();
        if (data == null) return;
        JSONObject msg;
        try {
            msg = new JSONObject(data);
        } catch (Exception e) {
            return;
        }

        String type = msg.optString("type");
        if ("title".equals(type) && isMainFrame) {
            title = msg.optString("title");
            if (PlaybackService.running) pushToService();
            return;
        }
        if ("theme".equals(type) && isMainFrame) {
            applyPageColor(msg.optString("bg"));
            return;
        }
        if (!"state".equals(type)) return;

        String state = msg.optString("state");
        if (!isMainFrame) playerProxy = replyProxy;

        switch (state) {
            case "playing":
                playing = true;
                userPaused = false;
                break;
            case "paused":
                // Safety net: if YouTube pauses itself right after we left the
                // app (and the user didn't ask for it), resume immediately.
                if (!inForeground && !userPaused && playerProxy != null
                        && SystemClock.elapsedRealtime() - backgroundedAt < AUTO_RESUME_WINDOW_MS) {
                    playerProxy.postMessage("play");
                    return;
                }
                playing = false;
                break;
            case "ended":
                playing = false;
                break;
            case "stopped":
                // Left the watch page: the player is gone.
                playing = false;
                playerProxy = null;
                web.setKeepScreenOn(false);
                stopService(new Intent(this, PlaybackService.class));
                return;
            default:
                return;
        }
        web.setKeepScreenOn(playing);
        pushToService();
    }

    private void pushToService() {
        Intent i = new Intent(this, PlaybackService.class)
                .setAction(PlaybackService.ACTION_UPDATE)
                .putExtra(PlaybackService.EXTRA_TITLE, title)
                .putExtra(PlaybackService.EXTRA_PLAYING, playing);
        try {
            if (PlaybackService.running) {
                startService(i);
            } else if (playing && inForeground) {
                startForegroundService(i);
            }
        } catch (RuntimeException ignored) {
            // Background-start restrictions: the next foreground event retries.
        }
    }

    // ─── PlaybackService.Controller (notification / lock screen buttons) ─────

    @Override
    public void play() {
        main.post(() -> {
            userPaused = false;
            if (playerProxy != null) playerProxy.postMessage("play");
        });
    }

    @Override
    public void pause() {
        main.post(() -> {
            userPaused = true;
            if (playerProxy != null) playerProxy.postMessage("pause");
        });
    }

    @Override
    public void close() {
        main.post(() -> {
            userPaused = true;
            playing = false;
            if (playerProxy != null) playerProxy.postMessage("pause");
            web.setKeepScreenOn(false);
        });
    }

    // ─── Fullscreen video ────────────────────────────────────────────────────

    private void enterFullscreen(View view, WebChromeClient.CustomViewCallback callback) {
        if (customView != null) {
            callback.onCustomViewHidden();
            return;
        }
        customView = view;
        customViewCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        root.setPadding(0, 0, 0, 0);
        root.addView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        setSystemBarsHidden(true);
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        if (customViewCallback != null) customViewCallback.onCustomViewHidden();
        customViewCallback = null;
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        setSystemBarsHidden(false);
        root.requestApplyInsets();
    }

    private void setSystemBarsHidden(boolean hidden) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        if (hidden) {
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsets.Type.systemBars());
        } else {
            c.show(WindowInsets.Type.systemBars());
        }
    }

    // ─── Layout / navigation ─────────────────────────────────────────────────

    private void setupEdgeToEdge() {
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (customView == null) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            }
            return WindowInsets.CONSUMED;
        });
    }

    private void setupBackHandling() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation") // API 33+ uses OnBackInvokedCallback above
    public void onBackPressed() {
        handleBack(); // API < 33
    }

    private void handleBack() {
        if (customView != null) {
            exitFullscreen();
        } else if (web.canGoBack()) {
            web.goBack();
        } else {
            // Leave the app like Home does, so playback keeps going.
            moveTaskToBack(true);
        }
    }

    // ─── Permissions / battery setup ─────────────────────────────────────────

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    /** Realme/ColorOS stop background apps aggressively; ask once to exempt us. */
    private void maybeShowBackgroundSetup() {
        if (isFinishing()) return;
        PowerManager pm = getSystemService(PowerManager.class);
        if (pm.isIgnoringBatteryOptimizations(getPackageName())) return;
        SharedPreferences prefs = getSharedPreferences("app", MODE_PRIVATE);
        if (prefs.getBoolean("bg_setup_done", false)) return;

        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle(R.string.bg_title)
                .setMessage(R.string.bg_message)
                .setPositiveButton(R.string.bg_allow, (d, w) -> {
                    prefs.edit().putBoolean("bg_setup_done", true).apply();
                    requestIgnoreBatteryOptimizations();
                })
                .setNegativeButton(R.string.bg_later, null)
                .show();
    }

    @SuppressLint("BatteryLife")
    private void requestIgnoreBatteryOptimizations() {
        openAppSettingsOnResume = true;
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            openAppSettingsOnResume = false;
            openAppDetails();
        }
    }

    private void openAppDetails() {
        Toast.makeText(this, R.string.bg_app_settings, Toast.LENGTH_LONG).show();
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) { }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            throw new IllegalStateException("Missing asset " + name, e);
        }
    }
}
