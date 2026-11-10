export const stylesheet = `
.appstudio-workbench {
  --as-bg: var(--dsw-alias-bg-base, Canvas);
  --as-panel: var(--dsw-alias-bg-layer-1, Canvas);
  --as-canvas: var(--dsw-alias-bg-module-platform, Canvas);
  --as-text: var(--dsw-alias-label-primary, CanvasText);
  --as-muted: var(--dsw-alias-label-secondary, CanvasText);
  --as-line: var(--dsw-alias-border-l2, GrayText);
  --as-accent: var(--dsw-alias-state-business-primary, #416ded);
  --as-tint: color-mix(in srgb, var(--as-accent) 8%, var(--as-panel));
  --as-shadow: 0 1px 2px #0b142908;
  box-sizing: border-box;
  container: appstudio / inline-size;
  height: 100%;
  overflow: auto;
  background: var(--as-bg);
  color: var(--as-text);
  font-size: 13px;
  line-height: 1.5;
}
.appstudio-workbench *, .appstudio-workbench *::before, .appstudio-workbench *::after { box-sizing: border-box; }
.appstudio-workbench [hidden] { display: none !important; }
.appstudio-workbench :is(h1, h2, h3, p) { margin: 0; }
.appstudio-workbench h1 { font-size: 27px; line-height: 1.13; font-weight: 680; letter-spacing: -.035em; }
.appstudio-workbench h2 { font-size: 16px; line-height: 1.35; font-weight: 650; letter-spacing: -.015em; }
.appstudio-workbench h3 { font-size: 14px; line-height: 1.4; font-weight: 650; }
.appstudio-workbench p { overflow-wrap: anywhere; }
.appstudio-workbench svg { flex: none; }
.appstudio-workbench :is(button, input, select, textarea):focus-visible, .appstudio-screen:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--as-accent));
  outline-offset: 2px;
}
.appstudio-workbench button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  max-width: 100%;
  padding: 6px 11px;
  font: inherit;
  font-weight: 540;
  line-height: 1.25;
  border: 1px solid var(--as-line);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--as-panel);
  color: var(--as-text);
  cursor: pointer;
}
.appstudio-workbench button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, ButtonFace); }
.appstudio-workbench button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--as-accent) 50%, var(--as-line)); color: var(--as-accent); }
.appstudio-workbench button:disabled { opacity: .52; cursor: default; }
.appstudio-workbench button.appstudio-primary {
  background: var(--dsw-alias-button-primary-fill, var(--as-accent));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-inverted, white);
}
.appstudio-workbench button.appstudio-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--as-accent)); }
.appstudio-workbench .appstudio-icon-button { width: 34px; padding: 0; flex: none; }
.appstudio-workbench :is(input:not([type="checkbox"]), select, textarea) {
  width: 100%;
  min-inline-size: 0;
  min-height: 36px;
  padding: 7px 9px;
  font: inherit;
  line-height: 1.45;
  color: var(--as-text);
  background: var(--as-bg);
  border: 1px solid var(--as-line);
  border-radius: var(--dsw-radius-sm, 8px);
}
.appstudio-workbench :is(input, textarea)::placeholder { color: var(--dsw-alias-label-tertiary, var(--as-muted)); }
.appstudio-workbench textarea { min-height: 70px; resize: vertical; }
.appstudio-workbench [role="alert"] { color: var(--dsw-alias-label-danger, #c53b43); }
.appstudio-workbench summary { width: fit-content; color: var(--as-muted); cursor: pointer; font-weight: 540; }
.appstudio-workbench details[open] summary { margin-bottom: 8px; }
.appstudio-shell { max-inline-size: 1480px; margin-inline: auto; padding: 24px clamp(14px, 2.3cqw, 34px) 36px; }
.appstudio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-inline-start: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 24px));
  margin-bottom: 18px;
}
.appstudio-brand, .appstudio-header-actions, .appstudio-workspace { display: flex; align-items: center; min-width: 0; gap: 10px; }
.appstudio-brand-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 45px;
  aspect-ratio: 1;
  border: 1px solid color-mix(in srgb, var(--as-accent) 22%, var(--as-line));
  border-radius: 13px;
  background: linear-gradient(145deg, var(--as-tint), var(--as-panel));
  color: var(--as-accent);
}
.appstudio-brand p { margin-top: 4px; color: var(--as-muted); }
.appstudio-header-actions { flex-wrap: wrap; justify-content: end; }
.appstudio-workspace {
  max-width: min(240px, 24cqw);
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--as-canvas);
  color: var(--as-muted);
  overflow: hidden;
}
.appstudio-workspace span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appstudio-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  margin-bottom: 16px;
  padding: 3px;
  border: 1px solid var(--as-line);
  border-radius: 11px;
  background: var(--as-canvas);
}
.appstudio-nav button {
  min-height: 33px;
  padding-inline: 13px;
  color: var(--as-muted);
  background: transparent;
  border-color: transparent;
}
.appstudio-nav button[aria-pressed="true"] { color: var(--as-text); background: var(--as-panel); border-color: var(--as-line); box-shadow: var(--as-shadow); }
.appstudio-active-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--as-accent); }
.appstudio-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.85fr) minmax(305px, 1fr);
  gap: 16px;
  align-items: start;
}
.appstudio-main-column, .appstudio-inspector { min-width: 0; }
.appstudio-inspector { display: grid; align-content: start; gap: 13px; }
.appstudio-surface, .appstudio-runtime {
  min-width: 0;
  border: 1px solid var(--as-line);
  border-radius: 15px;
  background: var(--as-panel);
  box-shadow: var(--as-shadow);
}
.appstudio-surface { overflow: clip; }
.appstudio-surface-header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 14px;
  padding: 17px 19px;
  border-bottom: 1px solid var(--as-line);
}
.appstudio-surface-header h2 { margin-block: 2px 3px; font-size: clamp(17px, 2cqw, 22px); }
.appstudio-surface-header p { color: var(--as-muted); }
.appstudio-surface-header .appstudio-eyebrow {
  color: var(--as-accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .10em;
  text-transform: uppercase;
}
.appstudio-status {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--as-line);
  border-radius: 999px;
  background: var(--as-canvas);
  color: var(--as-muted);
  font-size: 11px;
  font-weight: 650;
}
.appstudio-status::before, .appstudio-device-tab span[aria-live]::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.appstudio-status[data-phase="running"] { background: color-mix(in srgb, #218d6b 10%, var(--as-panel)); }
.appstudio-status[data-phase="running"]::before { background: #218d6b; }
.appstudio-status:is([data-phase="starting"], [data-phase="preparing"])::before { background: #d59426; }
.appstudio-status[data-phase="error"]::before { background: #cc4a54; }
.appstudio-runtime {
  display: grid;
  gap: 11px;
  padding: 14px;
}
.appstudio-runtime-title, .appstudio-license, .appstudio-actions, .appstudio-device-tabs, .appstudio-device-tab {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px 9px;
  min-width: 0;
}
.appstudio-runtime-title { justify-content: space-between; }
.appstudio-runtime-title [data-appstudio-project-state] { width: 100%; color: var(--as-muted); }
.appstudio-runtime p, .appstudio-device-status { color: var(--as-muted); }
.appstudio-runtime p[role="alert"] { color: var(--dsw-alias-label-danger, #c53b43); }
.appstudio-runtime-controls { scroll-margin-top: 16px; }
.appstudio-license label { display: inline-flex; align-items: center; gap: 7px; }
.appstudio-license a { color: var(--as-accent); text-decoration: underline; }
.appstudio-confirmation, .appstudio-project-fields, .appstudio-field {
  display: grid;
  gap: 6px;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.appstudio-confirmation { padding: 9px; background: var(--as-canvas); border-radius: 8px; }
.appstudio-project-fields > label, .appstudio-field, .appstudio-inline-field label { font-weight: 610; }
.appstudio-project-fields > label:not(:first-child) { margin-top: 4px; }
.appstudio-project-fields .appstudio-actions { margin-top: 3px; }
.appstudio-directory-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.appstudio-directory-field input { font-size: 12px !important; }
.appstudio-project-current { padding: 8px 10px; border-radius: 8px; background: var(--as-canvas); }
.appstudio-project-output {
  max-height: 205px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  background: var(--as-canvas);
  border: 1px solid var(--as-line);
  border-radius: 7px;
  color: var(--as-text);
  font: 11px/1.5 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.appstudio-created > div { display: flex; align-items: center; gap: 8px; }
.appstudio-created > div svg { color: #218d6b; }
.appstudio-created > button { justify-self: start; }
.appstudio-preview-empty, .appstudio-devices, .appstudio-layout-board {
  background:
    radial-gradient(color-mix(in srgb, var(--as-muted) 18%, transparent) 0.7px, transparent 0.7px) 0 0 / 15px 15px,
    radial-gradient(ellipse at 50% 32%, var(--as-tint), transparent 68%),
    var(--as-canvas);
}
.appstudio-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 17px;
  padding: 23px 18px 25px;
}
.appstudio-empty-phone {
  display: grid;
  grid-template-rows: auto 1fr auto;
  justify-items: center;
  gap: 12px;
  width: 124px;
  aspect-ratio: 9 / 16;
  padding: 9px;
  border: 1px solid var(--as-line);
  border-radius: 19px;
  box-shadow: 0 10px 24px #111b3219;
  background: var(--as-panel);
}
.appstudio-empty-phone > span { width: 26px; height: 3px; border-radius: 3px; background: var(--as-line); }
.appstudio-empty-phone > div {
  align-self: stretch;
  width: 100%;
  display: grid;
  place-items: center;
  color: var(--as-accent);
  background: var(--as-tint);
  border: 1px solid var(--as-line);
  border-radius: 12px;
}
.appstudio-empty-copy { max-width: 380px; padding: 9px 13px; text-align: center; background: var(--as-panel); border: 1px solid var(--as-line); border-radius: 10px; }
.appstudio-empty-copy p { margin-block: 4px 9px; color: var(--as-muted); }
.appstudio-devices { padding: 13px 12px 12px; min-width: 0; }
.appstudio-device-tabs { justify-content: center; margin-bottom: 13px; }
.appstudio-device-tab {
  justify-content: center;
  gap: 5px;
  padding: 3px 6px;
  border: 1px solid var(--as-line);
  border-radius: 9px;
  background: var(--as-panel);
}
.appstudio-device-tab strong { padding: 3px; font-weight: 640; }
.appstudio-device-tab span[aria-live] { display: flex; align-items: center; gap: 5px; color: var(--as-muted); font-size: 11px; }
.appstudio-device-status {
  width: fit-content;
  max-width: min(100%, 470px);
  margin: 9px auto 0 !important;
  padding: 4px 8px;
  border-radius: 7px;
  background: var(--as-panel);
  text-align: center;
}
.appstudio-screen {
  position: relative;
  width: min(100%, 346px, 45dvh);
  aspect-ratio: 9 / 16;
  margin-inline: auto;
  overflow: hidden;
  border-radius: 15px;
  outline: 1px solid #1c233549;
  box-shadow: 0 10px 26px #10172833, 0 0 0 5px var(--as-panel);
  background: #111;
  touch-action: none;
  user-select: none;
}
.appstudio-feed, .appstudio-feed :is(video, canvas) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.appstudio-feed[data-selected="false"],
.appstudio-feed[data-ready="false"] video,
.appstudio-feed[data-ready="true"] canvas { opacity: 0; }
.appstudio-screen[data-comment-mode="true"] { cursor: crosshair; }
.appstudio-selection {
  position: absolute;
  z-index: 1;
  border: 2px solid #4bbcff;
  box-shadow: 0 0 0 1px #092c56;
  background: #087cdb30;
  pointer-events: none;
}
.appstudio-selection[data-kind="point"] { width: 14px; height: 14px; border-radius: 50%; transform: translate(-50%, -50%); }
.appstudio-comment-frame { position: relative; width: 68px; max-width: 100%; }
.appstudio-comment-frame img { display: block; width: 100%; border-radius: 7px; }
.appstudio-comment-composer, .appstudio-comment-composer label { display: grid; gap: 6px; }
.appstudio-comment-list, .appstudio-comment-outcomes { display: grid; margin: 0; gap: 7px; }
.appstudio-comment-list { padding: 0; list-style: none; }
.appstudio-comment-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 7px; }
.appstudio-comment-list li p:first-child { color: var(--as-text); }
.appstudio-comment-outcomes { padding-inline-start: 19px; }
.appstudio-runtime[data-appstudio-iteration] .appstudio-actions label { width: 100%; display: grid; gap: 4px; font-weight: 610; }
.appstudio-generation-body, .appstudio-starter-form, .appstudio-generation-result { display: grid; gap: 13px; }
.appstudio-generation-body { padding: 16px; }
.appstudio-starter-modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); gap: 8px; }
.appstudio-starter-modes button {
  justify-content: start;
  gap: 9px;
  min-width: 0;
  padding: 10px;
  border-radius: 10px;
  text-align: start;
}
.appstudio-starter-modes button[aria-pressed="true"] { background: var(--as-tint); }
.appstudio-starter-modes :is(strong, small) { display: block; overflow-wrap: anywhere; }
.appstudio-starter-modes strong { font-size: 13px; color: var(--as-text); }
.appstudio-starter-modes small { margin-top: 4px; color: var(--as-muted); font-size: 11px; }
.appstudio-mode-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  aspect-ratio: 1;
  border-radius: 9px;
  color: var(--as-accent);
  background: var(--as-tint);
}
.appstudio-starter-submit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--as-line);
  border-radius: 9px;
  background: var(--as-canvas);
}
.appstudio-starter-submit > div { flex: 1 1 210px; }
.appstudio-starter-submit p, .appstudio-generation-result p { margin-top: 2px; color: var(--as-muted); }
.appstudio-generation-result {
  padding: 11px;
  border: 1px solid var(--as-line);
  border-radius: 9px;
  background: var(--as-canvas);
}
.appstudio-layout-editor { border: 1px solid var(--as-line); border-radius: 11px; overflow: clip; }
.appstudio-layout-toolbar { display: grid; gap: 8px; padding: 9px; border-bottom: 1px solid var(--as-line); }
.appstudio-layout-screens, .appstudio-inline-field { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.appstudio-layout-screens button { min-height: 30px; max-width: 155px; padding: 5px 8px; text-align: start; overflow-wrap: anywhere; }
.appstudio-layout-screens button[aria-pressed="true"] { background: var(--as-tint); }
.appstudio-inline-field input { flex: 1 1 130px; min-height: 33px; }
.appstudio-layout-area { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(0, 1.45fr); }
.appstudio-layout-tools { display: grid; gap: 8px; align-content: start; min-width: 0; padding: 9px; border-inline-end: 1px solid var(--as-line); }
.appstudio-layout-tools p { color: var(--as-muted); font-size: 11px; }
.appstudio-layout-palette { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 80px), 1fr)); gap: 5px; }
.appstudio-layout-palette button { justify-content: start; min-height: 32px; padding: 5px 6px; gap: 4px; font-size: 11px; }
.appstudio-layout-palette button[draggable="true"], .appstudio-layout-block[draggable="true"] { cursor: grab; }
.appstudio-layout-palette button svg { color: var(--as-accent); }
.appstudio-layout-properties { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--as-line); }
.appstudio-layout-properties label { font-size: 12px; }
.appstudio-layout-board { display: flex; justify-content: center; align-items: start; min-width: 0; padding: 12px 9px; }
.appstudio-layout-preview {
  width: min(100%, 246px);
  aspect-ratio: 9 / 16;
  min-height: 270px;
  max-height: 490px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--as-line);
  border-radius: 15px;
  background: var(--as-panel);
  box-shadow: 0 7px 19px #10172825;
}
.appstudio-layout-phone-top { display: flex; align-items: center; justify-content: center; gap: 3px; padding-block: 1px 8px; }
.appstudio-layout-phone-top span { width: 3px; height: 3px; border-radius: 50%; background: var(--as-line); }
.appstudio-layout-phone-top span:nth-child(2) { width: 22px; border-radius: 2px; }
.appstudio-layout-preview-title { padding: 0 3px 6px; color: var(--as-muted); font-size: 11px; font-weight: 650; overflow-wrap: anywhere; }
.appstudio-layout-drop-empty {
  display: grid;
  justify-items: center;
  place-content: center;
  gap: 6px;
  min-height: 115px;
  padding: 8px;
  border: 1px dashed color-mix(in srgb, var(--as-accent) 42%, var(--as-line));
  border-radius: 8px;
  background: var(--as-tint);
  color: var(--as-muted);
  text-align: center;
  font-size: 11px;
}
.appstudio-layout-drop-empty svg { color: var(--as-accent); }
.appstudio-layout-blocks { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.appstudio-layout-blocks li { position: relative; min-width: 0; }
.appstudio-layout-blocks li[data-drop-before="true"]::before, .appstudio-layout-drop-tail[data-drop-active="true"]::before {
  content: "";
  position: absolute;
  z-index: 2;
  inset: -3px 0 auto;
  height: 2px;
  border-radius: 2px;
  background: var(--as-accent);
  pointer-events: none;
}
.appstudio-layout-drop-tail { position: relative; min-height: 11px; }
.appstudio-layout-drop-tail[data-drop-active="true"]::before { inset-block-start: 2px; }
.appstudio-layout-blocks button.appstudio-layout-block {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  width: 100%;
  min-height: 29px;
  padding: 4px;
  gap: 3px;
  font-size: 11px;
  text-align: start;
  border-color: transparent;
}
.appstudio-layout-blocks button.appstudio-layout-block[aria-pressed="true"] { border-color: var(--as-accent); background: var(--as-tint); color: var(--as-text); }
.appstudio-layout-block > svg { color: var(--as-muted); }
.appstudio-layout-block-content { display: flex; align-items: center; gap: 6px; min-width: 0; }
.appstudio-layout-block-content > span { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.appstudio-layout-block[data-appstudio-layout-block="heading"] .appstudio-layout-block-content { font-size: 16px; font-weight: 690; }
.appstudio-layout-block[data-appstudio-layout-block="button"] .appstudio-layout-block-content {
  justify-content: center;
  padding: 5px;
  border-radius: 6px;
  background: var(--as-accent);
  color: var(--dsw-alias-label-primary-inverted, white);
}
.appstudio-layout-block:is([data-appstudio-layout-block="input"], [data-appstudio-layout-block="list"]) .appstudio-layout-block-content {
  padding: 5px;
  border: 1px solid var(--as-line);
  border-radius: 6px;
}
.appstudio-layout-block[data-appstudio-layout-block="image"] .appstudio-layout-block-content {
  justify-content: center;
  min-height: 52px;
  border-radius: 6px;
  background: var(--as-canvas);
  color: var(--as-muted);
}
.appstudio-layout-block[data-appstudio-layout-block="divider"] .appstudio-layout-block-content { height: 1px; background: var(--as-line); }
.appstudio-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container appstudio (max-width: 735px) {
  .appstudio-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .appstudio-inspector { gap: 11px; }
  .appstudio-workbench:has([data-appstudio-tab="starter"][aria-pressed="true"]) .appstudio-inspector { grid-row: 1; }
}
@container appstudio (max-width: 460px) {
  .appstudio-shell { padding-block-start: 15px; }
  .appstudio-header { align-items: start; }
  .appstudio-header-actions { gap: 5px; }
  .appstudio-header h1 { font-size: 21px; }
  .appstudio-header p, .appstudio-workspace { display: none; }
  .appstudio-brand { gap: 6px; }
  .appstudio-brand-icon { width: 33px; border-radius: 9px; }
  .appstudio-brand-icon svg { width: 17px; }
  .appstudio-surface-header { padding: 10px; gap: 8px; }
  .appstudio-status { white-space: normal; }
  .appstudio-generation-body { padding: 9px; }
  .appstudio-layout-area { grid-template-columns: minmax(0, 1fr); }
  .appstudio-layout-tools { border-inline-end: 0; border-bottom: 1px solid var(--as-line); }
  .appstudio-layout-board { padding-block: 9px; }
  .appstudio-comment-list li { grid-template-columns: auto minmax(0, 1fr); }
  .appstudio-comment-list li > button { grid-column: 2; justify-self: start; }
}
`
