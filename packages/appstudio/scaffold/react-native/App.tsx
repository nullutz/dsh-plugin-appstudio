import React, {useEffect, useRef, useState} from 'react';
import {
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {AppStudioScene} from './src/app-studio-scene';

type Block = {id: string; kind: 'heading' | 'text' | 'image' | 'input' | 'button' | 'list' | 'divider'; text: string};
type LayoutRow = {spaceBefore: number; cells: {span: number; block?: Block}[]};
type Screen = {id: string; title: string; rows: LayoutRow[]};
type Scene = {screen: string; drafts: Record<string, string>; selections: Record<string, number>; offsets: Record<string, number>};

const title = __TITLE_JS__;
const screens: Screen[] = __DESIGN_JS__;
const initial: Scene = {screen: screens[0].id, drafts: {}, selections: {}, offsets: {}};

export default function App() {
  const [scene, setScene] = useState<Scene>();
  const current = useRef(initial);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let open = true;
    AppStudioScene.load().then(raw => {
      if (!open) return;
      const saved = {...initial, ...(raw as Partial<Scene>)};
      current.current = screens.some(screen => screen.id === saved.screen) ? saved : {...saved, screen: initial.screen};
      setScene(current.current);
    }).catch(error => console.error('Could not restore the App Studio scene', error));
    return () => {
      open = false;
      clearTimeout(pending.current);
    };
  }, []);

  function publish() {
    clearTimeout(pending.current);
    AppStudioScene.save(current.current).catch(error => console.error('Could not publish the App Studio scene', error));
  }

  function navigate(id: string) {
    if (id === current.current.screen) return;
    clearTimeout(pending.current);
    Keyboard.dismiss();
    current.current = {...current.current, screen: id};
    setScene(current.current);
  }

  function recordOffset(id: string, offset: number, settled: boolean) {
    if (id !== current.current.screen) return;
    current.current = {...current.current, offsets: {...current.current.offsets, [id]: offset}};
    if (settled) {
      publish();
      return;
    }
    clearTimeout(pending.current);
    pending.current = setTimeout(publish, 80);
  }

  function updateDraft(key: string, value: string) {
    current.current = {...current.current, drafts: {...current.current.drafts, [key]: value}};
    setScene(current.current);
    publish();
  }

  function selectItem(key: string, index: number) {
    current.current = {...current.current, selections: {...current.current.selections, [key]: index}};
    setScene(current.current);
    publish();
  }

  const active = scene && screens.find(screen => screen.id === scene.screen);
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {active && screens.length > 1 && (
          <View style={styles.tabBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {screens.map(screen => (
                <Pressable key={screen.id} accessibilityRole="tab" accessibilityState={{selected: screen.id === active.id}}
                  onPress={() => navigate(screen.id)} style={[styles.tab, screen.id === active.id && styles.activeTab]}>
                  <Text style={styles.tabText}>{screen.title}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
        {active && scene && (
          <ScreenContent key={active.id} screen={active} scene={scene} offset={current.current.offsets[active.id] ?? 0}
            onOffset={(value, settled) => recordOffset(active.id, value, settled)} onDraft={updateDraft} onSelect={selectItem}
            onAction={label => {
              const next = screens[screens.indexOf(active) + 1];
              if (next) navigate(next.id);
              else Alert.alert(label);
            }} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function ScreenContent({screen, scene, offset, onOffset, onDraft, onSelect, onAction}: {
  screen: Screen; scene: Scene; offset: number; onOffset(value: number, settled: boolean): void;
  onDraft(key: string, value: string): void; onSelect(key: string, index: number): void; onAction(label: string): void;
}) {
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const requested = useRef(offset);
  const sizes = useRef({viewport: 0, content: 0});
  const pending = useRef<number | null>(null);
  const initialized = useRef(false);

  function restorePosition() {
    const {viewport, content} = sizes.current;
    if (initialized.current || viewport <= 0 || content <= 0) return;
    initialized.current = true;
    const target = Math.min(requested.current, Math.max(0, Math.floor(content - viewport)));
    if (target === 0) {
      onOffset(0, true);
    } else {
      pending.current = target;
      scroll.current?.scrollTo({y: target, animated: false});
    }
  }

  function renderBlock(block: Block) {
    const key = screen.id + ':' + block.id;
    const label = block.text;
    switch (block.kind) {
      case 'heading': return <Text style={styles.heading}>{label}</Text>;
      case 'text': return <Text style={styles.body}>{label}</Text>;
      case 'divider': return <View style={styles.divider} />;
      case 'image': return <View accessible accessibilityRole="image" accessibilityLabel={label} style={styles.image}>
        <Text numberOfLines={4} style={[styles.tabText, styles.imageLabel]}>{label}</Text>
      </View>;
      case 'input': return <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor="#59617c"
        value={scene.drafts[key] ?? ''} onChangeText={value => onDraft(key, value)} style={styles.input} />;
      case 'button': return <Pressable accessibilityRole="button" style={styles.action} onPress={() => onAction(label)}>
        <Text style={styles.actionText}>{label}</Text>
      </Pressable>;
      case 'list': return <View>
        {label.split(/\r?\n/).map((item, index) => (
          <Pressable key={index} accessibilityRole="button" accessibilityState={{selected: scene.selections[key] === index}}
            style={[styles.row, scene.selections[key] === index && styles.activeTab]} onPress={() => onSelect(key, index)}>
            <Text style={styles.body}>{item}</Text>
          </Pressable>
        ))}
      </View>;
    }
  }

  return (
    <ScrollView ref={scroll} accessibilityLabel="App content" keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content} scrollEventThrottle={16}
      onLayout={event => { sizes.current.viewport = event.nativeEvent.layout.height; restorePosition(); }}
      onContentSizeChange={(_, height) => { sizes.current.content = height; restorePosition(); }}
      onScroll={event => {
        if (!initialized.current) return;
        const actual = Math.round(Math.max(0, event.nativeEvent.contentOffset.y));
        const target = pending.current;
        if (target !== null && actual !== target) return;
        pending.current = null;
        onOffset(actual, target !== null);
      }}>
      <Text accessibilityRole="header" style={styles.screenTitle}>{screen.title}</Text>
      {screen.rows.map((row, rowIndex) => (
        <View key={rowIndex} style={[styles.layoutRow, {marginTop: row.spaceBefore}]}>
          {row.cells.map((cell, column) => (
            <View key={cell.block ? 'block:' + cell.block.id : 'space:' + column}
              style={[styles.layoutTrack, {flexGrow: cell.span}]}>
              {cell.block && <View style={row.cells.length > 1 && styles.layoutCell}>{renderBlock(cell.block)}</View>}
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  app: {flex: 1, backgroundColor: '#f8f9ff'},
  title: {fontSize: 26, fontWeight: '700', color: '#1e243b', marginHorizontal: 20, marginVertical: 12},
  tabBar: {height: 46},
  tabs: {paddingHorizontal: 20, gap: 8, alignItems: 'center'},
  tab: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: '#eef0fb'},
  activeTab: {backgroundColor: '#e0e2ff'},
  tabText: {fontWeight: '600', color: '#3831a0'},
  content: {padding: 20},
  layoutRow: {flexDirection: 'row', alignItems: 'flex-start'},
  layoutTrack: {flexBasis: 0, minWidth: 0},
  layoutCell: {paddingHorizontal: 4},
  screenTitle: {fontSize: 21, fontWeight: '700', color: '#1e243b'},
  heading: {fontSize: 24, fontWeight: '700', color: '#1e243b'},
  body: {fontSize: 16, color: '#1e243b'},
  divider: {height: 1, backgroundColor: '#dfe3f2'},
  image: {height: 126, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: '#e5e7ff'},
  imageLabel: {textAlign: 'center'},
  input: {minHeight: 52, paddingHorizontal: 12, borderColor: '#bbc2dc', borderWidth: 1, borderRadius: 10, color: '#1e243b'},
  action: {alignItems: 'center', borderRadius: 12, backgroundColor: '#4f46e5', padding: 14},
  actionText: {fontSize: 16, fontWeight: '700', color: 'white'},
  row: {minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderBottomWidth: 1, borderColor: '#e7e9f5'},
});
