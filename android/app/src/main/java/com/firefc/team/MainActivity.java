package com.firefc.team;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.firefc.team.widget.WidgetBridgePlugin;

public class MainActivity extends BridgeActivity {
    // GoalKickr brand dark (charcoal-950 = #0d0d10). Mirrors the
    // runtime StatusBar.setBackgroundColor call in nativeShell.ts and
    // the statusBarColor / navigationBarColor / windowBackground attrs
    // in styles.xml. Painted on EVERY paintable surface defensively
    // because (a) Samsung One UI ignores theme attributes, (b) Android
    // 15 deprecated statusBarColor and Pixel 10 XL specifically falls
    // back to its system default when the deprecated attribute is the
    // only color source. Was 0xFF0F172A (Fire FC navy) before the
    // rebrand — Patrick caught the leftover navy strip on Pixel 10
    // XL login 2026-06-21.
    private static final int GK_CHARCOAL = 0xFF0D0D10;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins. Must happen BEFORE
        // super.onCreate so the plugin is available the moment
        // the Bridge starts initializing the JS context. Each
        // additional plugin gets its own registerPlugin line.
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);

        // Android 15 (SDK 35) modern edge-to-edge opt-in. Replaces
        // the deprecated `android:windowOptOutEdgeToEdgeEnforcement`
        // theme attribute that Play Console flagged 2026-07-12. The
        // paired setOnApplyWindowInsetsListener below still handles
        // safe-area padding so the WebView keeps clear of the
        // status bar / gesture nav, giving the same visual result
        // the opt-out attribute produced — just via the currently-
        // supported API surface.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        // Defensive safe-area handling. Android 15 forces apps into
        // edge-to-edge; the theme attribute opts us out, but Samsung
        // One UI in particular tends to ignore that and still draws
        // the WebView under the status bar / gesture nav. Padding the
        // activity's root view by the system-bar insets shifts the
        // entire WebView into the visible safe area on those devices.
        // (On Android WebView, CSS env(safe-area-inset-*) is unreliable,
        // so we handle it natively here instead.)
        View root = findViewById(android.R.id.content);
        if (root != null) {
            // Paint the root view navy so the inset-padded strip above
            // the WebView (where the system bar sits) blends with the
            // app header instead of flashing white. Theme attributes
            // for windowBackground / statusBarColor are unreliable on
            // Samsung One UI, but the root view's drawing background
            // is honored everywhere.
            root.setBackgroundColor(GK_CHARCOAL);

            ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                v.setPadding(sys.left, sys.top, sys.right, sys.bottom);
                return insets;
            });
        }

        // Window decor background — covers any flicker before the
        // WebView attaches (e.g. between splash dismiss and first
        // paint). Also navy.
        getWindow().getDecorView().setBackgroundColor(GK_CHARCOAL);

        // WebView itself starts navy so the brief moment before
        // React mounts isn't white either.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.setBackgroundColor(GK_CHARCOAL);
        }
    }
}
