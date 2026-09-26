package tw.aaron.photoapp;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 把照片存到手機相簿的「Pictures/拍照App」，三星相簿會立即看到。
 * 傳入 uri 時覆寫同一張（例如調整長腿後更新）。
 */
@CapacitorPlugin(name = "Gallery")
public class GalleryPlugin extends Plugin {
    private static final String ALBUM = "拍照App";

    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName");
        String existing = call.getString("uri");
        if (data == null || fileName == null) {
            call.reject("缺少 data 或 fileName");
            return;
        }
        byte[] bytes = Base64.decode(data, Base64.DEFAULT);
        ContentResolver resolver = getContext().getContentResolver();
        try {
            Uri uri;
            if (existing != null) {
                uri = Uri.parse(existing);
                write(resolver, uri, bytes, "wt");
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/" + ALBUM);
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("無法建立相簿檔案");
                write(resolver, uri, bytes, "w");
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM);
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("無法建立資料夾");
                File file = new File(dir, fileName);
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { "image/jpeg" }, null);
                uri = Uri.fromFile(file);
            }
            JSObject result = new JSObject();
            result.put("uri", uri.toString());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("存到手機相簿失敗：" + e.getMessage(), e);
        }
    }

    private static void write(ContentResolver resolver, Uri uri, byte[] bytes, String mode) throws Exception {
        try (OutputStream out = resolver.openOutputStream(uri, mode)) {
            if (out == null) throw new Exception("無法寫入相簿檔案");
            out.write(bytes);
        }
    }
}
