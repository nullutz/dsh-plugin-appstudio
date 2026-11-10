package dev.appstudio.starter

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        if (!SceneStore.enabled(this)) return
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "appstudio/scene")
            .setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "load" -> result.success(SceneStore.load(this))
                        "save" -> {
                            SceneStore.save(this, call.arguments as String)
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (error: Exception) {
                    result.error("scene", error.message, null)
                }
            }
    }
}
