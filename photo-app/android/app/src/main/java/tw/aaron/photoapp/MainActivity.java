package tw.aaron.photoapp;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自訂外掛要在 super.onCreate 之前註冊
        registerPlugin(GalleryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
