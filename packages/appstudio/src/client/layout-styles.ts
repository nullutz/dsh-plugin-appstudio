export const layoutStyles = String.raw`
.appstudio-layout-editor { display: grid; gap: 12px; min-width: 0; container: studio-layout / inline-size; }
.appstudio-layout-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-width: 0; }
.appstudio-layout-toolbar, .appstudio-layout-editor .appstudio-layout-hint { margin-inline: var(--as-gutter); }
.appstudio-layout-screens { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; min-width: 0; }
.appstudio-layout-editor .appstudio-layout-screens button {
  min-height: 36px;
  max-width: 150px;
  padding: 7px 11px;
  border-color: transparent;
  background: transparent;
  text-align: start;
  overflow-wrap: anywhere;
}
.appstudio-layout-editor .appstudio-layout-screens button[aria-pressed="true"] {
  color: var(--as-accent);
  background: var(--as-tint);
}
.appstudio-layout-screen-field { display: flex; align-items: center; gap: 5px; min-width: 0; flex: 0 1 180px; }
.appstudio-layout-editor .appstudio-layout-screen-field input { background: transparent; }
.appstudio-layout-area { display: grid; grid-template-columns: minmax(calc(142px + var(--as-gutter)), calc(172px + var(--as-gutter))) minmax(0, 1fr); gap: 14px; }
.appstudio-layout-tools { display: grid; align-content: start; gap: 12px; min-width: 0; padding-block: 12px; padding-inline-start: var(--as-gutter); }
.appstudio-layout-tools p, .appstudio-layout-editor .appstudio-layout-hint { color: var(--as-muted); font-size: 12px; }
.appstudio-layout-palette { display: grid; gap: 2px; }
.appstudio-layout-editor .appstudio-layout-palette button {
  justify-content: flex-start;
  min-height: 40px;
  padding: 5px 4px;
  gap: 10px;
  border-color: transparent;
  background: transparent;
  text-align: start;
}
.appstudio-layout-editor [draggable="true"] { cursor: grab; }
.appstudio-layout-editor [draggable="true"]:active { cursor: grabbing; }
.appstudio-layout-editor [data-kind="heading"] { --block-surface: #d8d8ff; --block-ink: #343377; }
.appstudio-layout-editor [data-kind="text"] { --block-surface: #cce8ff; --block-ink: #254a70; }
.appstudio-layout-editor [data-kind="image"] { --block-surface: #e8d8ff; --block-ink: #513074; }
.appstudio-layout-editor [data-kind="input"] { --block-surface: #c9ede7; --block-ink: #20544d; }
.appstudio-layout-editor [data-kind="button"] { --block-surface: #ffd7c6; --block-ink: #713927; }
.appstudio-layout-editor [data-kind="list"] { --block-surface: #e1edc2; --block-ink: #405623; }
.appstudio-layout-editor [data-kind="divider"] { --block-surface: #e3e7f0; --block-ink: #4b546b; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="heading"] { --block-surface: #4c4a85; --block-ink: #f3f1ff; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="text"] { --block-surface: #305773; --block-ink: #e8f6ff; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="image"] { --block-surface: #644680; --block-ink: #fbf0ff; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="input"] { --block-surface: #2b625a; --block-ink: #e1fff7; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="button"] { --block-surface: #824d39; --block-ink: #fff2e8; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="list"] { --block-surface: #515f36; --block-ink: #f5ffdf; }
[data-ds-dark-theme] .appstudio-layout-editor [data-kind="divider"] { --block-surface: #4a5265; --block-ink: #eff3ff; }
.appstudio-layout-swatch {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: var(--block-surface);
  color: var(--block-ink);
}
.appstudio-layout-properties { display: grid; gap: 9px; min-width: 0; padding-block-start: 12px; border-block-start: 1px solid var(--as-line); }
.appstudio-layout-properties .appstudio-field { font-size: 12px; }
.appstudio-layout-editor .appstudio-layout-properties textarea { min-height: 56px; }
.appstudio-layout-edit-actions { display: flex; gap: 1px; align-items: center; }
.appstudio-layout-editor .appstudio-layout-edit-actions button {
  flex: 0 1 34px;
  min-width: 0;
  min-height: 31px;
  padding: 0;
  border-color: transparent;
  background: transparent;
}
.appstudio-layout-edit-actions button span { display: flex; }
.appstudio-layout-edit-actions button:last-child { margin-inline-start: auto; color: var(--as-muted); }
.appstudio-layout-board {
  position: relative;
  isolation: isolate;
  min-width: 0;
  min-height: clamp(520px, 62dvh, 710px);
  overflow: clip;
  touch-action: none;
  cursor: grab;
  background: var(--as-stage-paint);
}
.appstudio-layout-board[data-panning="true"] { cursor: grabbing; user-select: none; }
.appstudio-layout-artboard { position: absolute; left: 50%; top: 42px; transform-origin: center top; cursor: default; }
.appstudio-layout-artboard-label {
  position: absolute;
  inset-inline: 0;
  bottom: calc(100% + 8px);
  color: var(--as-muted);
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
.appstudio-layout-preview {
  position: relative;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--as-muted) 24%, transparent);
  border-radius: 18px;
  background: var(--as-panel);
  box-shadow: 0 12px 40px #09132113;
}
.appstudio-layout-blocks {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: 8px;
  --grid-ink: color-mix(in srgb, var(--as-muted) 9%, transparent);
  background-image: linear-gradient(to right, var(--grid-ink) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-ink) 1px, transparent 1px);
}
.appstudio-layout-preview[data-dropping="true"] .appstudio-layout-blocks {
  --grid-ink: color-mix(in srgb, var(--as-accent) 19%, transparent);
}
.appstudio-layout-blocks li { min-width: 0; min-height: 0; padding: 4px; }
.appstudio-layout-blocks li[data-moving="true"] { opacity: .32; }
.appstudio-layout-blocks button.appstudio-layout-block {
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--block-surface);
  color: var(--block-ink);
  text-align: start;
  overflow: hidden;
}
.appstudio-layout-blocks button.appstudio-layout-block:hover:not(:disabled) {
  background: color-mix(in srgb, var(--block-surface) 93%, var(--block-ink));
}
.appstudio-layout-blocks button.appstudio-layout-block[aria-pressed="true"] {
  outline: 2px solid var(--as-accent);
  outline-offset: 1px;
}
.appstudio-layout-blocks button.appstudio-layout-block:focus-visible {
  outline: 2px solid var(--as-accent);
  outline-offset: 3px;
}
.appstudio-layout-block[data-kind="heading"] { font-weight: 700; }
.appstudio-layout-block > span {
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.appstudio-layout-block[data-kind="divider"] > span { height: 1px; flex: 1; background: currentColor; opacity: .56; }
.appstudio-layout-blocks li.appstudio-layout-drop-target {
  z-index: 1;
  margin: 4px;
  padding: 0;
  border: 1px dashed var(--as-accent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--as-accent) 18%, transparent);
  pointer-events: none;
}
.appstudio-layout-drop-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 8px;
  color: var(--as-muted);
  pointer-events: none;
}
.appstudio-layout-drop-empty svg { color: var(--as-accent); }
.appstudio-layout-zoom {
  position: absolute;
  display: flex;
  align-items: center;
  inset-inline-end: 12px;
  bottom: 12px;
  padding: 3px;
  border: 1px solid var(--as-line);
  border-radius: 10px;
  background: var(--as-panel);
  box-shadow: var(--as-shadow);
  cursor: default;
}
.appstudio-layout-editor .appstudio-layout-zoom button {
  min-width: 33px;
  min-height: 33px;
  padding: 4px 6px;
  border: 0;
  background: transparent;
  font-variant-numeric: tabular-nums;
}
.appstudio-layout-zoom button:first-child { font-size: 20px; }
.appstudio-layout-zoom button:nth-child(2) { min-width: 50px; }
@container studio-layout (max-width: 520px) {
  .appstudio-layout-toolbar { flex-wrap: wrap; gap: 8px; }
  .appstudio-layout-screen-field { flex: 1 1 120px; }
  .appstudio-layout-area { grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .appstudio-layout-tools { padding-block: 0; padding-inline: var(--as-gutter); gap: 5px; }
  .appstudio-layout-palette { display: flex; flex-wrap: wrap; }
  .appstudio-layout-editor .appstudio-layout-palette button { min-height: 32px; padding: 3px 5px; gap: 5px; font-size: 12px; }
  .appstudio-layout-swatch { width: 23px; height: 23px; }
  .appstudio-layout-properties { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .appstudio-layout-properties h3, .appstudio-layout-edit-actions { grid-column: 1 / -1; }
}
`
