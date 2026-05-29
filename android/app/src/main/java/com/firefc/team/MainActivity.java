package com.firefc.team;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
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
            ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
                Insets sys = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                v.setPadding(sys.left, sys.top, sys.right, sys.bottom);
                return insets;
            });
        }
    }
}
