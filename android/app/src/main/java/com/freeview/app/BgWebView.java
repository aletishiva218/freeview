package com.freeview.app;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * WebView that keeps reporting itself as visible when the app goes to the
 * background or the screen turns off. Chromium derives the page's
 * visibilityState from this callback, so the page (and the YouTube player
 * inside it) never sees a "hidden" transition and never pauses itself.
 */
public class BgWebView extends WebView {

    public BgWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // Backgrounding the app reports GONE here (ViewRootImpl#getHostVisibility).
        super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
