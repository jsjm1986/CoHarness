package com.coharness;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (BuildConfig.NATIVE_PUSH_ENABLED) {
            registerPlugin(NativePushStatusPlugin.class);
        }
        super.onCreate(savedInstanceState);
        if (!BuildConfig.NATIVE_PUSH_ENABLED) return;
        PluginHandle handle = getBridge() == null ? null : getBridge().getPlugin("NativePushStatus");
        if (handle != null && handle.getInstance() instanceof NativePushStatusPlugin) {
            ((NativePushStatusPlugin) handle.getInstance()).handleInitialIntent(getIntent());
        }
    }
}
