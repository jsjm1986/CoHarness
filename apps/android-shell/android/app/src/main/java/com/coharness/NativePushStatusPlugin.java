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
import org.unifiedpush.android.connector.UnifiedPush;
import static org.unifiedpush.android.connector.ConstantsKt.INSTANCE_DEFAULT;

/** Reports whether the Android build contains Firebase client configuration. */
@CapacitorPlugin(name = "NativePushStatus")
public class NativePushStatusPlugin extends Plugin {
    public static final String EVENT_NOTIFICATION_ACTION = "notificationAction";
    public static final String EVENT_UNIFIEDPUSH_ENDPOINT = "unifiedPushEndpoint";
    public static final String EXTRA_SESSION_ID = "coharness.sessionId";
    public static final String EXTRA_RUNTIME_ID = "coharness.runtimeId";
    public static final String EXTRA_EVENT_SEQ = "coharness.eventSeq";
    public static final String EXTRA_PUSH_PROVIDER = "coharness.pushProvider";

    private static volatile NativePushStatusPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Forward a distributor-issued endpoint to the web layer; retained until a listener consumes it. */
    static void emitUnifiedPushEndpoint(String endpoint) {
        NativePushStatusPlugin plugin = instance;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("endpoint", endpoint);
        plugin.notifyListeners(EVENT_UNIFIEDPUSH_ENDPOINT, event, true);
    }

    @PluginMethod
    public void isConfigured(PluginCall call) {
        boolean configured = BuildConfig.NATIVE_PUSH_ENABLED && (isFcmConfigured() || jPushAppKeyConfigured());

        JSObject result = new JSObject();
        result.put("configured", configured);
        call.resolve(result);
    }

    @PluginMethod
    public void isFcmConfigured(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", BuildConfig.NATIVE_PUSH_ENABLED && isFcmConfigured());
        call.resolve(result);
    }

    @PluginMethod
    public void getJPushRegistrationId(PluginCall call) {
        String registrationId = "";
        if (BuildConfig.NATIVE_PUSH_ENABLED && jPushAppKeyConfigured()) {
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
        result.put("configured", BuildConfig.NATIVE_PUSH_ENABLED && jPushAppKeyConfigured());
        call.resolve(result);
    }

    @PluginMethod
    public void initializeJPush(PluginCall call) {
        JSObject result = new JSObject();
        result.put("configured", CoHarnessApplication.initializeJPush(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void initializeUnifiedPush(PluginCall call) {
        JSObject result = new JSObject();
        if (!BuildConfig.NATIVE_PUSH_ENABLED) {
            result.put("configured", false);
            call.resolve(result);
            return;
        }
        java.util.List<String> distributors = UnifiedPush.getDistributors(getContext());
        android.app.Activity activity = getActivity();
        result.put("distributors", new com.getcapacitor.JSArray(distributors));
        if (distributors.isEmpty() || activity == null) {
            result.put("configured", false);
            call.resolve(result);
            return;
        }
        // Distributor selection can surface a system picker, so the API requires an Activity.
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity, success -> {
            if (success) {
                UnifiedPush.register(getContext(), INSTANCE_DEFAULT, null, null);
            }
            result.put("configured", success);
            call.resolve(result);
            return kotlin.Unit.INSTANCE;
        });
    }

    @PluginMethod
    public void getPushStatus(PluginCall call) {
        boolean fcmConfigured = BuildConfig.NATIVE_PUSH_ENABLED && isFcmConfigured();
        boolean jpushConfigured = BuildConfig.NATIVE_PUSH_ENABLED && jPushAppKeyConfigured();
        String registrationId = "";
        if (jpushConfigured && CoHarnessApplication.jpushConsentGranted(getContext())) {
            try {
                String value = JPushInterface.getRegistrationID(getContext());
                if (value != null) registrationId = value.trim();
            } catch (RuntimeException error) {
                Log.w("NativePushStatus", "JPush RegistrationID lookup failed", error);
            }
        }
        String unifiedpushDistributor = "";
        String unifiedpushEndpoint = "";
        if (BuildConfig.NATIVE_PUSH_ENABLED) {
            try {
                String distributor = UnifiedPush.getAckDistributor(getContext());
                if (distributor != null) unifiedpushDistributor = distributor;
            } catch (RuntimeException error) {
                Log.w("NativePushStatus", "UnifiedPush distributor lookup failed", error);
            }
            unifiedpushEndpoint = CoHarnessPushService.storedEndpoint(getContext());
        }
        JSObject result = new JSObject();
        result.put("configured", fcmConfigured || jpushConfigured || !unifiedpushEndpoint.isEmpty());
        result.put("fcmConfigured", fcmConfigured);
        result.put("jpushConfigured", jpushConfigured);
        result.put("jpushInitialized", BuildConfig.NATIVE_PUSH_ENABLED
            && jpushConfigured && CoHarnessApplication.jpushConsentGranted(getContext()));
        result.put("notificationsEnabled",
            androidx.core.app.NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        result.put("registrationId", registrationId);
        result.put("unifiedpushDistributor", unifiedpushDistributor);
        result.put("unifiedpushEndpoint", unifiedpushEndpoint);
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
        String runtimeId = intent.getStringExtra(EXTRA_RUNTIME_ID);
        if (sessionId == null || sessionId.trim().isEmpty() || runtimeId == null || runtimeId.trim().isEmpty()) return;
        JSObject result = new JSObject();
        result.put("sessionId", sessionId.trim());
        result.put("runtimeId", runtimeId.trim());
        String eventSeq = intent.getStringExtra(EXTRA_EVENT_SEQ);
        if (eventSeq != null && !eventSeq.trim().isEmpty()) result.put("eventSeq", eventSeq.trim());
        notifyListeners(EVENT_NOTIFICATION_ACTION, result, true);
        // A UnifiedPush-launched intent carries its provider; report the open receipt against the
        // stored endpoint token, then clear the extra so the tap cannot double-report.
        if ("unifiedpush".equals(intent.getStringExtra(EXTRA_PUSH_PROVIDER))
            && getBridge() != null && eventSeq != null && !eventSeq.trim().isEmpty()) {
            PushReceiptReporter.report(getContext(), "unifiedpush",
                CoHarnessPushService.storedEndpoint(getContext()),
                runtimeId.trim(), sessionId.trim(), eventSeq.trim(), "opened");
        }
        intent.removeExtra(EXTRA_PUSH_PROVIDER);
        intent.removeExtra(EXTRA_SESSION_ID);
        intent.removeExtra(EXTRA_RUNTIME_ID);
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
