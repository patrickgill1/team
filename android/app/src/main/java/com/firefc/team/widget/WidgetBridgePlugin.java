package com.firefc.team.widget;

import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge between the React app and the widget's SharedPreferences.
 * Lets WidgetSetupCard.tsx write the user's widget token from JS
 * into a known prefs slot, then the {@link PlayerWidgetConfigure}
 * activity reads it on widget-add and skips the paste UI entirely.
 *
 * "global_token" is per-user-account, not per-widget-instance. Each
 * widget instance still copies the value into its own prefs key on
 * configure so the widget host's per-instance refresh keeps working
 * the same as the manual-paste flow.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {
    static final String GLOBAL_TOKEN_KEY = "global_token";

    @PluginMethod
    public void setToken(PluginCall call) {
        String token = call.getString("token", "");
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PlayerWidgetProvider.PREFS_NAME, 0);
        prefs.edit().putString(GLOBAL_TOKEN_KEY, token == null ? "" : token).apply();
        call.resolve();
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PlayerWidgetProvider.PREFS_NAME, 0);
        String token = prefs.getString(GLOBAL_TOKEN_KEY, "");
        JSObject ret = new JSObject();
        ret.put("token", token == null ? "" : token);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        SharedPreferences prefs = getContext()
            .getSharedPreferences(PlayerWidgetProvider.PREFS_NAME, 0);
        prefs.edit().remove(GLOBAL_TOKEN_KEY).apply();
        call.resolve();
    }
}
