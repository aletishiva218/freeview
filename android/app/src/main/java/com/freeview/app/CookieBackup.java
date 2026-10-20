package com.freeview.app;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;

import java.util.ArrayList;
import java.util.List;

/**
 * Keeps the website's preference cookies (chosen categories, theme) across
 * app restarts.
 *
 * WebView holds cookies in memory and writes them to disk only every ~30 s.
 * When the process is killed (swiping the app away from Recents ends the
 * process so playback stops; Realme also kills background apps), unwritten
 * cookies are lost and the site asks for categories again. So we flush the
 * cookie store and also copy these cookies into SharedPreferences (written
 * synchronously), and put them back before the page loads if WebView lost them.
 */
final class CookieBackup {

    private static final String[] NAMES = {"fv_cats", "fv_theme"};
    private static final String PREFS = "cookie_backup";
    private static final int MAX_AGE_SECONDS = 365 * 24 * 3600;

    private CookieBackup() { }

    /** Saves the current preference cookies and flushes WebView's cookie store. */
    @SuppressLint("ApplySharedPref") // must hit disk now: the process may be killed next
    static void save(Context ctx, String url) {
        CookieManager cm = CookieManager.getInstance();
        String all = cm.getCookie(url);
        SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (String name : NAMES) {
            String value = valueOf(all, name);
            if (value != null && !value.isEmpty()) e.putString(name, value);
            else e.remove(name); // e.g. theme set back to System
        }
        e.commit();
        cm.flush();
    }

    /**
     * Restores any saved cookie WebView no longer has, then runs {@code then}
     * on the main thread (once, even if a callback never arrives).
     */
    static void restore(Context ctx, String url, Runnable then) {
        CookieManager cm = CookieManager.getInstance();
        String all = cm.getCookie(url);
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        List<String> missing = new ArrayList<>();
        for (String name : NAMES) {
            String saved = sp.getString(name, null);
            if (saved != null && valueOf(all, name) == null) {
                missing.add(name + "=" + saved + "; Max-Age=" + MAX_AGE_SECONDS
                        + "; Path=/; Secure; SameSite=Lax");
            }
        }
        if (missing.isEmpty()) {
            then.run();
            return;
        }

        Handler main = new Handler(Looper.getMainLooper());
        boolean[] done = {false};
        int[] left = {missing.size()};
        Runnable finish = () -> {
            if (done[0]) return;
            done[0] = true;
            cm.flush();
            then.run();
        };
        for (String cookie : missing) {
            cm.setCookie(url, cookie, ok -> {
                if (--left[0] == 0) finish.run();
            });
        }
        main.postDelayed(finish, 1500); // safety net
    }

    /** Value of cookie {@code name} in a "a=1; b=2" header string, or null. */
    static String valueOf(String cookies, String name) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String p = part.trim();
            if (p.startsWith(name + "=")) return p.substring(name.length() + 1);
        }
        return null;
    }
}
