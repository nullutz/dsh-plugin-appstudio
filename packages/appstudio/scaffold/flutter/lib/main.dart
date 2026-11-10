import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'app_studio_scene.dart';

const _title = __TITLE_DART__;
const _design = __DESIGN_DART__;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final checkpoint = await AppStudioScene.load();
  runApp(MaterialApp(
    title: _title,
    debugShowCheckedModeBanner: false,
    theme: ThemeData(colorSchemeSeed: const Color(0xff4f46e5)),
    home: StarterApp(checkpoint: checkpoint),
  ));
}

class StarterApp extends StatefulWidget {
  const StarterApp({super.key, required this.checkpoint});

  final Map<String, dynamic> checkpoint;

  @override
  State<StarterApp> createState() => _StarterAppState();
}

class _StarterAppState extends State<StarterApp> {
  final _screens = (jsonDecode(_design) as List).cast<Map<String, dynamic>>();
  late final Map<String, String> _drafts;
  late final Map<String, int> _selections;
  late final Map<String, int> _offsets;
  late ScrollController _scroll;
  int _active = 0;
  Timer? _pendingSave;

  Map<String, dynamic> get _screen => _screens[_active];
  String get _screenId => _screen['id'] as String;

  @override
  void initState() {
    super.initState();
    final checkpoint = widget.checkpoint;
    _drafts = Map<String, String>.from(checkpoint['drafts'] as Map? ?? {});
    _selections = Map<String, int>.from(checkpoint['selections'] as Map? ?? {});
    _offsets = Map<String, int>.from(checkpoint['offsets'] as Map? ?? {});
    final index = _screens.indexWhere((screen) => screen['id'] == checkpoint['screen']);
    if (index >= 0) _active = index;
    _scroll = _scrollFor(_screenId);
    WidgetsBinding.instance.addPostFrameCallback((_) => _laidOut(_scroll));
  }

  ScrollController _scrollFor(String id) {
    final controller = ScrollController(
      initialScrollOffset: (_offsets[id] ?? 0).toDouble(),
      keepScrollOffset: false,
    );
    controller.addListener(() {
      if (!controller.hasClients || _scroll != controller) return;
      _offsets[id] = controller.offset.round();
      _pendingSave?.cancel();
      _pendingSave = Timer(const Duration(milliseconds: 80), _publish);
    });
    return controller;
  }

  void _laidOut(ScrollController controller) {
    if (!mounted || _scroll != controller || !controller.hasClients) return;
    _offsets[_screenId] = controller.offset.round();
    _publish();
  }

  void _publish() {
    if (!mounted) return;
    unawaited(AppStudioScene.save({
      'screen': _screenId,
      'drafts': _drafts,
      'selections': _selections,
      'offsets': _offsets,
    }).catchError((Object error) => debugPrint('App Studio scene: $error')));
  }

  void _navigate(int index) {
    if (_active == index) return;
    FocusScope.of(context).unfocus();
    _pendingSave?.cancel();
    final previous = _scroll;
    setState(() {
      _active = index;
      _scroll = _scrollFor(_screenId);
    });
    final current = _scroll;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      previous.dispose();
      _laidOut(current);
    });
  }

  @override
  Widget build(BuildContext context) {
    final style = Theme.of(context).textTheme;
    final blocks = (_screen['blocks'] as List).cast<Map<String, dynamic>>();
    return Scaffold(
      appBar: AppBar(title: const Text(_title)),
      body: SafeArea(
        child: Column(children: [
          if (_screens.length > 1)
            SizedBox(
              height: 52,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 20),
                itemCount: _screens.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (context, index) => ChoiceChip(
                  label: Text(_screens[index]['title'] as String),
                  selected: index == _active,
                  onSelected: (_) => _navigate(index),
                ),
              ),
            ),
          Expanded(child: SingleChildScrollView(
            key: ValueKey(_screenId),
            controller: _scroll,
            padding: const EdgeInsets.all(20),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text(_screen['title'] as String, style: style.titleLarge),
              for (final block in blocks)
                Padding(padding: const EdgeInsets.only(top: 12), child: _block(block)),
            ]),
          )),
        ]),
      ),
    );
  }

  Widget _block(Map<String, dynamic> block) {
    final theme = Theme.of(context);
    final text = block['text'] as String;
    final key = '$_screenId:${block['id']}';
    return switch (block['kind']) {
      'heading' => Text(text, style: theme.textTheme.headlineSmall),
      'text' => Text(text, style: theme.textTheme.bodyLarge),
      'divider' => const Divider(),
      'image' => Container(
        height: 126,
        decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(20)),
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
          const Icon(Icons.image_outlined), Text(text),
        ]),
      ),
      'input' => TextFormField(
        key: ValueKey(key),
        initialValue: _drafts[key],
        decoration: InputDecoration(labelText: text, border: const OutlineInputBorder()),
        onChanged: (value) {
          _drafts[key] = value;
          _publish();
        },
      ),
      'button' => FilledButton(
        onPressed: () {
          if (_active + 1 < _screens.length) {
            _navigate(_active + 1);
          } else {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
          }
        },
        child: Text(text),
      ),
      'list' => Column(children: [
        for (final (index, title) in text.split('\n').indexed)
          ListTile(
            title: Text(title),
            selected: _selections[key] == index,
            onTap: () {
              setState(() => _selections[key] = index);
              _publish();
            },
          ),
      ]),
      _ => throw StateError('Unsupported layout block'),
    };
  }

  @override
  void dispose() {
    _pendingSave?.cancel();
    _scroll.dispose();
    super.dispose();
  }
}
