import { layoutStyles } from './layout-styles.ts'

export const stylesheet = `
.appstudio-workbench {
  --as-bg: var(--dsw-alias-bg-base, Canvas);
  --as-panel: var(--dsw-alias-bg-layer-1, Canvas);
  --as-canvas: var(--dsw-alias-bg-module-platform, Canvas);
  --as-text: var(--dsw-alias-label-primary, CanvasText);
  --as-muted: var(--dsw-alias-label-secondary, CanvasText);
  --as-line: color-mix(in srgb, var(--as-text) 14%, transparent);
  --as-accent: var(--dsw-alias-state-business-primary, #416ded);
  --as-tint: color-mix(in srgb, var(--as-accent) 13%, var(--as-panel));
  --as-shadow: 0 2px 12px #07132616;
  --as-gutter: clamp(14px, 2.15cqw, 34px);
  --as-header-size: 68px;
  --as-stage-paint:
    radial-gradient(color-mix(in srgb, var(--as-text) 17%, transparent) .75px, transparent .75px) 0 0 / 23px 23px,
    radial-gradient(ellipse at 48% 42%, color-mix(in srgb, var(--as-accent) 7%, transparent), transparent 65%),
    color-mix(in srgb, var(--as-canvas) 54%, var(--as-bg));
  box-sizing: border-box;
  container: appstudio / size;
  height: 100%;
  overflow: auto;
  background: var(--as-bg);
  color: var(--as-text);
  font-size: 14px;
  line-height: 1.5;
}
.appstudio-workbench *, .appstudio-workbench *::before, .appstudio-workbench *::after { box-sizing: border-box; }
.appstudio-workbench [hidden] { display: none !important; }
.appstudio-workbench :is(h1, h2, h3, p) { margin: 0; }
.appstudio-workbench h1 { font-size: 25px; line-height: 1.15; font-weight: 700; letter-spacing: -.042em; }
.appstudio-workbench h2 { font-size: 17px; line-height: 1.3; font-weight: 660; letter-spacing: -.025em; }
.appstudio-workbench h3 { font-size: 16px; line-height: 1.4; font-weight: 650; }
.appstudio-workbench p { overflow-wrap: anywhere; }
.appstudio-workbench svg { flex: none; }
.appstudio-workbench :is(button, a, input, select, textarea):focus-visible, .appstudio-screen:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--as-accent));
  outline-offset: 2px;
}
.appstudio-workbench button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 38px;
  max-width: 100%;
  padding: 7px 12px;
  font: inherit;
  font-weight: 560;
  line-height: 1.25;
  border: 1px solid var(--as-line);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--as-panel);
  color: var(--as-text);
  cursor: pointer;
}
.appstudio-workbench button:hover:not(:disabled) { background: var(--as-tint); }
.appstudio-workbench button[aria-pressed="true"] { border-color: var(--as-accent); color: var(--as-accent); }
.appstudio-workbench button:disabled { opacity: .53; cursor: default; }
.appstudio-workbench button.appstudio-primary {
  background: var(--dsw-alias-button-primary-fill, var(--as-accent));
  border-color: transparent;
  color: var(--dsw-alias-label-primary-inverted, white);
}
.appstudio-workbench button.appstudio-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--as-accent));
}
.appstudio-workbench .appstudio-icon-button { width: 40px; min-height: 40px; padding: 0; flex: none; }
.appstudio-workbench :is(input:not([type="checkbox"]), select, textarea) {
  width: 100%;
  min-inline-size: 0;
  min-height: 40px;
  padding: 8px 10px;
  font: inherit;
  line-height: 1.45;
  color: var(--as-text);
  background: var(--as-bg);
  border: 1px solid var(--as-line);
  border-radius: var(--dsw-radius-sm, 8px);
}
.appstudio-workbench :is(input, textarea)::placeholder { color: var(--dsw-alias-label-tertiary, var(--as-muted)); }
.appstudio-workbench textarea { min-height: 76px; resize: vertical; }
.appstudio-workbench a { color: var(--as-accent); text-underline-offset: .2em; }
.appstudio-workbench [role="alert"] { color: var(--dsw-alias-label-danger, #c53b43); }
.appstudio-workbench summary { width: fit-content; color: var(--as-muted); cursor: pointer; font-weight: 560; }
.appstudio-workbench details[open] summary { margin-bottom: 8px; }
.appstudio-shell { display: flex; flex-direction: column; min-block-size: 100%; }
.appstudio-header {
  position: sticky;
  z-index: 4;
  inset-block-start: 0;
  display: grid;
  grid-template-columns: minmax(max-content, 1fr) auto minmax(0, 1fr);
  align-items: stretch;
  min-block-size: var(--as-header-size);
  gap: 22px;
  padding-inline: max(var(--as-gutter), var(--dsh-frame-leading-clearance, 0px)) var(--as-gutter);
  border-bottom: 1px solid var(--as-line);
  background: var(--as-bg);
}
.appstudio-brand, .appstudio-header-actions, .appstudio-workspace { display: flex; align-items: center; min-width: 0; gap: 11px; }
.appstudio-brand-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  aspect-ratio: 1;
  border-radius: 12px;
  background: var(--as-tint);
  color: var(--as-accent);
}
.appstudio-header-actions { justify-content: end; }
.appstudio-workspace { max-width: 250px; color: var(--as-muted); }
.appstudio-workspace-text { display: grid; gap: 1px; min-width: 0; line-height: 1.2; }
.appstudio-workspace :is(small, strong) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appstudio-workspace small { font-size: 11px; }
.appstudio-workspace strong { color: var(--as-text); font-weight: 620; }
.appstudio-workspace + .appstudio-settings-button { margin-inline-start: 3px; }
.appstudio-workbench .appstudio-settings-button { background: transparent; border-color: transparent; color: var(--as-muted); }
.appstudio-workbench .appstudio-settings-button[aria-expanded="true"] { background: var(--as-tint); color: var(--as-accent); }
.appstudio-nav { display: flex; align-items: stretch; justify-content: center; gap: 8px; }
.appstudio-nav button {
  position: relative;
  justify-content: center;
  padding-inline: 16px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--as-muted);
  font-size: 15px;
  white-space: nowrap;
}
.appstudio-nav button:hover:not(:disabled) { background: color-mix(in srgb, var(--as-accent) 7%, transparent); }
.appstudio-nav button[aria-pressed="true"] { color: var(--as-text); font-weight: 680; }
.appstudio-nav button[aria-pressed="true"] svg { color: var(--as-accent); }
.appstudio-nav button[aria-pressed="true"]::after {
  content: "";
  position: absolute;
  inset: auto 12px -1px;
  height: 3px;
  border-radius: 3px 3px 0 0;
  background: var(--as-accent);
}
.appstudio-active-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--as-accent); }
.appstudio-grid {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(310px, 26cqw, 370px);
  min-block-size: 0;
}
.appstudio-main-column, .appstudio-inspector { min-width: 0; }
.appstudio-main-column { display: grid; }
.appstudio-inspector {
  min-width: 0;
  background: var(--as-bg);
  border-inline-start: 1px solid var(--as-line);
}
.appstudio-inspector > :not([hidden]) ~ :not([hidden]) { border-block-start: 1px solid var(--as-line); }
.appstudio-stage { display: flex; flex-direction: column; min-width: 0; background: var(--as-stage-paint); }
.appstudio-surface-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.appstudio-surface-header h2 { font-size: clamp(21px, 2.1cqw, 28px); }
.appstudio-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--as-muted);
  font-size: 12px;
  font-weight: 580;
  overflow-wrap: anywhere;
}
.appstudio-status::before, .appstudio-device-tab span[aria-live]::before {
  content: "";
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.appstudio-status[data-phase="running"]::before, .appstudio-device-tab[data-state="ready"] span[aria-live]::before { background: #32a885; }
.appstudio-status:is([data-phase="starting"], [data-phase="preparing"])::before { background: #d59426; }
.appstudio-status[data-phase="error"]::before,
.appstudio-device-tab:is([data-state="disconnected"], [data-state="projectDeviceFailed"]) span[aria-live]::before { background: #dd5c66; }
.appstudio-runtime {
  display: grid;
  gap: 13px;
  min-width: 0;
  padding: 21px clamp(15px, 1.8cqw, 24px);
}
.appstudio-runtime-title, .appstudio-license, .appstudio-actions, .appstudio-device-tabs, .appstudio-device-tab {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.appstudio-runtime-title { justify-content: space-between; }
.appstudio-runtime-title [data-appstudio-project-state] { width: 100%; color: var(--as-muted); }
.appstudio-runtime p, .appstudio-device-status { color: var(--as-muted); }
.appstudio-runtime p[role="alert"] { color: var(--dsw-alias-label-danger, #c53b43); }
.appstudio-runtime-controls { gap: 0; padding-block: 11px 13px; scroll-margin-block: 12px; }
.appstudio-workbench .appstudio-runtime-toggle {
  justify-content: start;
  text-align: start;
  width: 100%;
  padding-inline: 4px;
  border: 0;
  background: transparent;
}
.appstudio-runtime-toggle > svg { rotate: -90deg; color: var(--as-muted); }
.appstudio-runtime-toggle[aria-expanded="true"] > svg { rotate: 0deg; }
.appstudio-runtime-toggle strong { margin-inline-end: auto; font-weight: 640; }
.appstudio-runtime-body { display: grid; gap: 12px; padding: 8px 4px 5px; }
.appstudio-license label { display: inline-flex; align-items: center; gap: 7px; }
.appstudio-confirmation, .appstudio-project-fields, .appstudio-field {
  display: grid;
  gap: 7px;
  min-inline-size: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.appstudio-confirmation { border-inline-start: 2px solid var(--as-line); padding-inline-start: 10px; }
.appstudio-project-fields > label, .appstudio-field { font-weight: 610; }
.appstudio-project-fields > label:not(:first-child) { margin-top: 5px; }
.appstudio-project-fields .appstudio-actions { margin-top: 4px; }
.appstudio-directory-field { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 6px; }
.appstudio-directory-field input { font-size: 13px !important; }
.appstudio-project-current { font-size: 13px; }
.appstudio-project-output {
  max-height: 225px;
  overflow: auto;
  margin: 0;
  padding: 10px;
  background: var(--as-canvas);
  border-radius: 7px;
  color: var(--as-text);
  font: 12px/1.5 ui-monospace, Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.appstudio-created { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
.appstudio-created > div { display: flex; align-items: center; gap: 7px; }
.appstudio-created > div svg { color: #32a885; }
.appstudio-created > button { justify-self: start; }
.appstudio-preview-empty {
  flex: 1;
  display: grid;
  align-content: center;
  justify-items: center;
  min-block-size: max(420px, calc(100cqh - var(--as-header-size) - 1px));
  padding: 32px var(--as-gutter);
  gap: 24px;
}
.appstudio-empty-phone {
  display: grid;
  grid-template-rows: auto 1fr auto;
  justify-items: center;
  gap: 12px;
  width: clamp(100px, 17cqh, 144px);
  aspect-ratio: 9 / 16;
  padding: 11px;
  border: 1px solid var(--as-line);
  border-radius: 22px;
  box-shadow: 0 16px 34px #07132620;
  background: var(--as-panel);
}
.appstudio-empty-phone > span { width: 26px; height: 3px; border-radius: 3px; background: var(--as-line); }
.appstudio-empty-phone > div {
  display: grid;
  place-items: center;
  width: 100%;
  color: var(--as-accent);
  background: var(--as-tint);
  border-radius: 13px;
}
.appstudio-empty-copy { max-width: 400px; text-align: center; }
.appstudio-empty-copy h3 { font-size: 23px; letter-spacing: -.025em; }
.appstudio-empty-copy p { margin-block: 6px 16px; color: var(--as-muted); }
.appstudio-devices { display: grid; align-content: start; gap: 14px; padding-bottom: 16px; min-width: 0; }
.appstudio-device-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  min-height: 66px;
  min-width: 0;
  gap: 8px 16px;
  padding: 10px var(--as-gutter);
  border-bottom: 1px solid var(--as-line);
  background: var(--as-bg);
}
.appstudio-device-heading { min-width: 0; }
.appstudio-device-heading h2 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.appstudio-device-heading p { margin-top: 2px; color: var(--as-muted); font-size: 12px; }
.appstudio-device-tabs { gap: 6px 14px; }
.appstudio-device-tab { position: relative; gap: 5px; }
.appstudio-workbench .appstudio-device-tab > button:first-child { border: 0; background: transparent; }
.appstudio-workbench .appstudio-device-tab > button:first-child:hover:not(:disabled),
.appstudio-workbench .appstudio-device-tab > button[aria-pressed="true"]:first-child { background: var(--as-tint); }
.appstudio-device-tab span[aria-live] { display: inline-flex; align-items: center; gap: 4px; color: var(--as-muted); font-size: 11px; }
.appstudio-workbench .appstudio-comment-toggle { background: transparent; }
.appstudio-workbench .appstudio-comment-toggle[aria-pressed="true"] { background: var(--as-tint); }
.appstudio-device-status {
  width: fit-content;
  max-width: min(calc(100% - 28px), 500px);
  margin-inline: auto !important;
  text-align: center;
  font-size: 13px;
}
.appstudio-stage > .appstudio-device-status { margin-block: 12px !important; }
.appstudio-screen {
  position: relative;
  width: min(calc(100% - 2 * var(--as-gutter)), clamp(372px, calc((100cqh - var(--as-header-size) - 126px) * .5625), 540px));
  aspect-ratio: 9 / 16;
  margin-inline: auto;
  overflow: hidden;
  border-radius: 19px;
  outline: 1px solid #13203160;
  box-shadow: 0 17px 42px #07132642, 0 0 0 4px var(--as-panel);
  background: #111;
  touch-action: none;
  user-select: none;
}
.appstudio-media, .appstudio-feed, .appstudio-feed :is(video, canvas) {
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
.appstudio-comment-composer, .appstudio-comment-composer label { display: grid; gap: 7px; }
.appstudio-comment-list, .appstudio-comment-outcomes { display: grid; margin: 0; gap: 8px; }
.appstudio-comment-list { padding: 0; list-style: none; }
.appstudio-comment-list li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 7px; }
.appstudio-comment-list li p:first-child { color: var(--as-text); }
.appstudio-comment-outcomes { padding-inline-start: 20px; }
.appstudio-runtime[data-appstudio-iteration] .appstudio-actions label { width: 100%; display: grid; gap: 5px; font-weight: 610; }
.appstudio-generation {
  display: grid;
  align-content: start;
  gap: 12px;
  min-width: 0;
  padding-block-end: 28px;
}
.appstudio-starter-name, .appstudio-starter-brief, .appstudio-starter-help,
.appstudio-generation-result, .appstudio-generation-body > p {
  margin-inline: var(--as-gutter);
}
.appstudio-generation-body, .appstudio-starter-form, .appstudio-generation-result { display: grid; min-width: 0; gap: 14px; }
.appstudio-generation > header {
  position: sticky;
  z-index: 2;
  inset-block-start: var(--as-header-size);
  flex-wrap: wrap;
  padding: 11px var(--as-gutter);
  border-block-end: 1px solid var(--as-line);
  background: var(--as-bg);
}
.appstudio-starter-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.appstudio-starter-modes { display: flex; flex-wrap: wrap; gap: 6px; }
.appstudio-starter-modes button { border-color: transparent; background: transparent; color: var(--as-muted); }
.appstudio-starter-modes button[aria-pressed="true"] { border-color: transparent; background: var(--as-tint); color: var(--as-accent); }
.appstudio-starter-name {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  width: min(100% - 2 * var(--as-gutter), 360px);
}
.appstudio-starter-brief { max-width: 770px; }
.appstudio-starter-form[data-mode="prompt"] .appstudio-starter-brief textarea { min-block-size: 215px; }
.appstudio-starter-help, .appstudio-generation-result p { color: var(--as-muted); }
.appstudio-generation-result { padding-block-start: 15px; border-block-start: 1px solid var(--as-line); }
.appstudio-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@container appstudio (width > 795px) {
  .appstudio-inspector {
    position: sticky;
    inset-block-start: var(--as-header-size);
    align-self: start;
    block-size: calc(100cqh - var(--as-header-size));
    overflow-y: auto;
    overscroll-behavior-y: contain;
  }
}
@container appstudio (max-height: 680px) {
  .appstudio-screen { width: min(calc(100% - 2 * var(--as-gutter)), clamp(250px, calc((100cqh - 170px) * .5625), 372px)); }
}
@container appstudio (max-width: 795px) {
  .appstudio-grid { grid-template-columns: minmax(0, 1fr); }
  .appstudio-inspector { border-inline-start: 0; border-block-start: 1px solid var(--as-line); }
  .appstudio-inspector > div:first-child, .appstudio-runtime-controls { scroll-margin-block-start: calc(var(--as-header-size) + 12px); }
  .appstudio-header { gap: 9px; }
  .appstudio-nav { gap: 1px; }
  .appstudio-nav button { padding-inline: 10px; }
  .appstudio-created { grid-template-columns: minmax(0, 1fr); }
}
@container appstudio (max-width: 570px) {
  .appstudio-shell { --as-header-size: 104px; }
  .appstudio-header {
    grid-template-columns: minmax(max-content, 1fr) minmax(0, 1fr);
    grid-template-rows: 56px 48px;
    column-gap: 7px;
    row-gap: 0;
  }
  .appstudio-brand { gap: 7px; }
  .appstudio-brand h1 { font-size: 20px; }
  .appstudio-brand-icon { width: 34px; border-radius: 9px; }
  .appstudio-brand-icon svg { width: 20px; }
  .appstudio-header-actions { gap: 5px; }
  .appstudio-workspace { gap: 5px; }
  .appstudio-workspace small, .appstudio-workspace > svg { display: none; }
  .appstudio-nav { grid-area: 2 / 1 / 3 / -1; justify-content: start; }
  .appstudio-nav button { padding-inline: 11px; }
  .appstudio-generation > header { position: static; }
  .appstudio-device-bar { padding-block: 9px; }
  .appstudio-device-tabs { gap: 4px 7px; }
  .appstudio-workbench .appstudio-device-tab > button:first-child { padding-inline: 6px; }
  .appstudio-comment-list li { grid-template-columns: auto minmax(0, 1fr); }
  .appstudio-comment-list li > button { grid-column: 2; justify-self: start; }
}
${layoutStyles}
`
