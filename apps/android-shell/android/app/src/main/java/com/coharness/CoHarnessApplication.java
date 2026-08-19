package com.coharness;

import android.app.ActivityManager;
import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import cn.jiguang.api.utils.JCollectionAuth;
import cn.jpush.android.api.JPushInterface;

/** Initializes JPush after the user has enabled push notifications. */
public final class CoHarnessApplication extends Application {
    private static final String TAG = "CoHarnessApplication";
    private static final String PUSH_PREFERENCES = "coharness.push";
    private static final String JPUSH_CONSENT = "jpush-consent";

    @Override
    public void onCreate() {
        super.onCreate();
        if (!BuildConfig.NATIVE_PUSH_ENABLED || !isMainProcess() || !jPushAppKeyConfigured(this)) return;
        if (getSharedPreferences(PUSH_PREFERENCES, MODE_PRIVATE)
            .getBoolean(JPUSH_CONSENT, false)) {
            initializeJPush(this);
        }
    }

    /** Enables JPush after the native notification-consent flow has completed. */
    public static boolean initializeJPush(Context context) {
        Context appContext = context.getApplicationContext();
        if (!BuildConfig.NATIVE_PUSH_ENABLED || !isMainProcess(appContext) || !jPushAppKeyConfigured(appContext)) {
            return false;
        }
        if (appContext.getSharedPreferences(PUSH_PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(JPUSH_CONSENT, false)) return true;
        try {
            ApplicationInfo info = appContext.getPackageManager().getApplicationInfo(
                appContext.getPackageName(), PackageManager.GET_META_DATA
            );
            Bundle metadata = info.metaData;
            if (metadata == null) return false;
            String appKey = metadata.getString("JPUSH_APPKEY");
            if (appKey == null || appKey.trim().isEmpty()) return false;
            JCollectionAuth.setAuth(appContext, true);
            boolean debug = (info.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            JPushInterface.setDebugMode(debug);
            JPushInterface.init(appContext);
            appContext.getSharedPreferences(PUSH_PREFERENCES, Context.MODE_PRIVATE)
                .edit().putBoolean(JPUSH_CONSENT, true).apply();
            return true;
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        } catch (RuntimeException error) {
            Log.w(TAG, "JPush initialization failed; continuing without JPush", error);
            return false;
        }
    }

    private boolean isMainProcess() {
        return isMainProcess(this);
    }

    private static boolean isMainProcess(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return context.getPackageName().equals(Application.getProcessName());
        }
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            int pid = Process.myPid();
            java.util.List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
            if (processes != null) {
                for (ActivityManager.RunningAppProcessInfo process : processes) {
                    if (process.pid == pid) return context.getPackageName().equals(process.processName);
                }
            }
        }
        return true;
    }

    private static boolean jPushAppKeyConfigured(Context context) {
        try {
            ApplicationInfo info = context.getPackageManager().getApplicationInfo(
                context.getPackageName(), PackageManager.GET_META_DATA
            );
            Bundle metadata = info.metaData;
            if (metadata == null) return false;
            String appKey = metadata.getString("JPUSH_APPKEY");
            return appKey != null && !appKey.trim().isEmpty();
        } catch (PackageManager.NameNotFoundException error) {
            return false;
        }
    }
}
