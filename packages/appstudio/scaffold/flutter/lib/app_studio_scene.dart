import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Debug bridge. Keep this file and publish after the restored UI has laid out.
abstract final class AppStudioScene {
  static const _channel = MethodChannel('appstudio/scene');

  static Future<Map<String, dynamic>> load() async {
    if (!kDebugMode) return {};
    final raw = await _channel.invokeMethod<String>('load');
    return (jsonDecode(raw ?? '{}') as Map).cast<String, dynamic>();
  }

  static Future<void> save(Map<String, dynamic> state) async {
    if (!kDebugMode) return;
    await _channel.invokeMethod<void>('save', jsonEncode(state));
  }
}
