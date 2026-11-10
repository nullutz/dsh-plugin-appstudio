package dev.appstudio.starter;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.uimanager.ViewManager;
import java.util.Collections;
import java.util.List;

public final class ReactScenePackage implements ReactPackage {
    @Override public List<NativeModule> createNativeModules(ReactApplicationContext context) {
        return Collections.singletonList(new SceneModule(context));
    }

    @Override public List<ViewManager> createViewManagers(ReactApplicationContext context) {
        return Collections.emptyList();
    }

    public static final class SceneModule extends ReactContextBaseJavaModule {
        SceneModule(ReactApplicationContext context) { super(context); }
        @Override public String getName() { return "AppStudioScene"; }

        @ReactMethod public void load(Promise promise) {
            try { promise.resolve(SceneStore.load(getReactApplicationContext())); }
            catch (Exception error) { promise.reject("scene", error); }
        }

        @ReactMethod public void save(String json, Promise promise) {
            try {
                SceneStore.save(getReactApplicationContext(), json);
                promise.resolve(null);
            } catch (Exception error) { promise.reject("scene", error); }
        }
    }
}
