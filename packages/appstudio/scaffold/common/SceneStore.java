package dev.appstudio.starter;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Process;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** App Studio's Android debug scene interface. Release builds do not exchange scenes. */
public final class SceneStore {
    private static final int MAX_BYTES = 256 * 1024;
    private static final String SAVED = "appstudio-scene.json";
    private static final String RESUME = "appstudio-resume.json";

    private SceneStore() {}

    public static boolean enabled(Context context) {
        return (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    public static synchronized String load(Context context) throws Exception {
        if (!enabled(context)) return "{}";
        File resume = new File(context.getFilesDir(), RESUME);
        boolean restoring = resume.isFile();
        File input = restoring ? resume : new File(context.getFilesDir(), SAVED);
        if (!input.isFile()) return "{}";
        if (input.length() > MAX_BYTES) throw new IOException("Scene exceeds the size limit");
        byte[] bytes = new AtomicFile(input).readFully();
        if (bytes.length > MAX_BYTES) throw new IOException("Scene exceeds the size limit");
        JSONObject state = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        if (restoring && !resume.delete()) throw new IOException("Could not consume the restored scene");
        state.remove("pid");
        state.remove("nativeVersion");
        return state.toString();
    }

    @SuppressWarnings("deprecation")
    public static synchronized void save(Context context, String json) throws Exception {
        if (!enabled(context)) return;
        JSONObject state = new JSONObject(json);
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        long version = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
        state.put("nativeVersion", version);
        state.put("pid", Process.myPid());
        byte[] bytes = state.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) throw new IOException("Scene exceeds the size limit");
        AtomicFile file = new AtomicFile(new File(context.getFilesDir(), SAVED));
        FileOutputStream stream = file.startWrite();
        try {
            stream.write(bytes);
            file.finishWrite(stream);
        } catch (IOException error) {
            file.failWrite(stream);
            throw error;
        }
    }
}
