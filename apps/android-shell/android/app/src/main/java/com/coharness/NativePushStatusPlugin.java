package com.coharness;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import cn.jpush.android.api.JPushInterface;

/** Reports whether the Android build contains Firebase client configuration. */
@CapacitorPlugin(name = "NativePushStatus")
public class NativePushStatusPlugin extends Plugin {
    public static final String EVENT_NOTIFICATION_ACTION = "notificationAction";
    public static final String EXTRA_SESSION_ID = "coharness.sessionId";
    public static final String EXTRA_EVENT_SEQ = "coharness.eventSeq";

    @PluginMethod
    public void isConfigured(PluginCall call) {
        boolean configured = isFcmConfigured() || jPushAppKeyConfigured();

        JSObject result = new JSObject();
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void isFcmConfigured(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", isFcmConfigured());
        call.resolve(result);
    }

    @PluginMethod
    public void getJPushRegistrationId(PluginCall call) {
        String registrationId = "";
        if (jPushAppKeyConfigured()) {
            try {
                String value = JPushInterface.getRegistrationID(getContext());
                if (value != null) registrationId = value.trim();
            } catch (RuntimeException error) {
                Log.w("NativePushStatus", "JPush RegistrationID lookup failed", error);
            }
        }
        JSObject result = new JSObject();
        result.put("registrationId", registrationId);
        call.resolve(result);
    }

    @PluginMethod
    public void isJPushConfigured(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", jPushAppKeyConfigured());
        call.resolve(result);
    }

    @PluginMethod
    public void initializeJPush(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", CoHarnessApplication.initializeJPush(getContext()));
        call.resolve(result);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        handleNotificationIntent(intent);
    }

    /** Delivers a notification click from the launch intent after a cold start. */
    public void handleInitialIntent(Intent intent) {
        handleNotificationIntent(intent);
    }

    private void handleNotificationIntent(Intent intent) {
        if (intent == null) return;
        String sessionId = intent.getStringExtra(EXTRA_SESSION_ID);
        if (sessionId == null || sessionId.trim().isEmpty()) return;
        JSObject result = new JSObject();
        result.put("sessionId", sessionId.trim());
        String eventSeq = intent.getStringExtra(EXTRA_EVENT_SEQ);
        if (eventSeq != null && !eventSeq.trim().isEmpty()) result.put("eventSeq", eventSeq.trim());
        notifyListeners(EVENT_NOTIFICATION_ACTION, result, true);
        intent.removeExtra(EXTRA_SESSION_ID);
        intent.removeExtra(EXTRA_EVENT_SEQ);
    }

    private boolean jPushAppKeyConfigured() {
        try {
            ApplicationInfo info = getContext().getPackageManager().getApplicationInfo(
                getContext().getPackageName(), PackageManager.GET_META_DATA
            );
            if (info.metaData == null) return false;
            String appKey = info.metaData.getString("JPUSH_APPKEY");
            return appKey != null && !appKey.trim().isEmpty();
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }

    private boolean isFcmConfigured() {
        int resourceId = getContext().getResources().getIdentifier(
            "google_app_id",
            "string",
            getContext().getPackageName()
        );
        if (resourceId == 0) return false;
        String appId = getContext().getString(resourceId).trim();
        return !appId.isEmpty() && !appId.equals("${google_app_id}");
    }
}
