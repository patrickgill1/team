package com.firefc.team;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // App's primary navy. Mirrors #0f172a used in src/utils/nativeShell.ts
    // and the styles.xml theme attributes. Set on every paintable
    // surface defensively because Samsung One UI ignores half of them.
    private static final int FIREFC_NAVY = 0xFF0F172A;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
            root.setBackgroundColor(FIREFC_NAVY);

            ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                v.setPadding(sys.left, sys.top, sys.right, sys.bottom);
                return insets;
            });
        }

        // Window decor background — covers any flicker before the
        // WebView attaches (e.g. between splash dismiss and first
        // paint). Also navy.
        getWindow().getDecorView().setBackgroundColor(FIREFC_NAVY);

        // WebView itself starts navy so the brief moment before
        // React mounts isn't white either.
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.setBackgroundColor(FIREFC_NAVY);
        }
    }
}
