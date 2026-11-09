/**
 * Colour themes and the base stylesheet shared by the live preview webview and
 * the standalone HTML export. Pure strings: no DOM, no vscode.
 */

export const THEME_NAMES = [
  'github-light',
  'github-dark',
  'one-light',
  'one-dark',
  'solarized-light',
  'solarized-dark',
  'monokai',
  'dracula',
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export type ColorScheme =
  | 'selectedPreviewTheme'
  | 'systemColorScheme'
  | 'editorColorScheme';

interface Palette {
  dark: boolean;
  bg: string;
  elev: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  hover: string;
  key: string;
  str: string;
  num: string;
  bool: string;
  nul: string;
  date: string;
  anchor: string;
  alias: string;
  tag: string;
  cmt: string;
  err: string;
  warn: string;
  ok: string;
  code: string;
}

const P: Record<ThemeName, Palette> = {
  'github-light': {
    dark: false, bg: '#ffffff', elev: '#f6f8fa', fg: '#1f2328', muted: '#656d76', border: '#d0d7de', accent: '#0969da', hover: '#eaeef2',
    key: '#116329', str: '#0a3069', num: '#0550ae', bool: '#cf222e', nul: '#6e7781', date: '#8250df', anchor: '#bc4c00', alias: '#8250df', tag: '#953800', cmt: '#6e7781',
    err: '#cf222e', warn: '#9a6700', ok: '#1a7f37', code: '#f6f8fa',
  },
  'github-dark': {
    dark: true, bg: '#0d1117', elev: '#161b22', fg: '#e6edf3', muted: '#8b949e', border: '#30363d', accent: '#2f81f7', hover: '#1f2630',
    key: '#7ee787', str: '#a5d6ff', num: '#79c0ff', bool: '#ff7b72', nul: '#8b949e', date: '#d2a8ff', anchor: '#ffa657', alias: '#d2a8ff', tag: '#ffa657', cmt: '#8b949e',
    err: '#ff7b72', warn: '#d29922', ok: '#3fb950', code: '#161b22',
  },
  'one-light': {
    dark: false, bg: '#fafafa', elev: '#f0f0f1', fg: '#383a42', muted: '#80828a', border: '#dbdbdc', accent: '#4078f2', hover: '#ececed',
    key: '#e45649', str: '#50a14f', num: '#986801', bool: '#0184bc', nul: '#a0a1a7', date: '#a626a4', anchor: '#c18401', alias: '#a626a4', tag: '#c18401', cmt: '#a0a1a7',
    err: '#e45649', warn: '#c18401', ok: '#50a14f', code: '#f0f0f1',
  },
  'one-dark': {
    dark: true, bg: '#282c34', elev: '#21252b', fg: '#abb2bf', muted: '#7f848e', border: '#3e4451', accent: '#61afef', hover: '#2c313a',
    key: '#e06c75', str: '#98c379', num: '#d19a66', bool: '#56b6c2', nul: '#7f848e', date: '#c678dd', anchor: '#e5c07b', alias: '#c678dd', tag: '#e5c07b', cmt: '#7f848e',
    err: '#e06c75', warn: '#e5c07b', ok: '#98c379', code: '#21252b',
  },
  'solarized-light': {
    dark: false, bg: '#fdf6e3', elev: '#eee8d5', fg: '#586e75', muted: '#93a1a1', border: '#e4ddc6', accent: '#268bd2', hover: '#f1ebd6',
    key: '#268bd2', str: '#2aa198', num: '#d33682', bool: '#cb4b16', nul: '#93a1a1', date: '#6c71c4', anchor: '#b58900', alias: '#6c71c4', tag: '#b58900', cmt: '#93a1a1',
    err: '#dc322f', warn: '#b58900', ok: '#859900', code: '#eee8d5',
  },
  'solarized-dark': {
    dark: true, bg: '#002b36', elev: '#073642', fg: '#93a1a1', muted: '#657b83', border: '#0b4552', accent: '#268bd2', hover: '#06303b',
    key: '#268bd2', str: '#2aa198', num: '#d33682', bool: '#cb4b16', nul: '#657b83', date: '#6c71c4', anchor: '#b58900', alias: '#6c71c4', tag: '#b58900', cmt: '#657b83',
    err: '#dc322f', warn: '#b58900', ok: '#859900', code: '#073642',
  },
  monokai: {
    dark: true, bg: '#272822', elev: '#1e1f1c', fg: '#f8f8f2', muted: '#8f8f80', border: '#3e3d32', accent: '#66d9ef', hover: '#33342c',
    key: '#a6e22e', str: '#e6db74', num: '#ae81ff', bool: '#ae81ff', nul: '#8f8f80', date: '#66d9ef', anchor: '#fd971f', alias: '#f92672', tag: '#fd971f', cmt: '#8f8f80',
    err: '#f92672', warn: '#fd971f', ok: '#a6e22e', code: '#1e1f1c',
  },
  dracula: {
    dark: true, bg: '#282a36', elev: '#21222c', fg: '#f8f8f2', muted: '#8a94c6', border: '#44475a', accent: '#bd93f9', hover: '#313442',
    key: '#50fa7b', str: '#f1fa8c', num: '#bd93f9', bool: '#ff79c6', nul: '#8a94c6', date: '#8be9fd', anchor: '#ffb86c', alias: '#ff79c6', tag: '#ffb86c', cmt: '#8a94c6',
    err: '#ff5555', warn: '#ffb86c', ok: '#50fa7b', code: '#21222c',
  },
};

function vars(p: Palette): string {
  return [
    `--bg:${p.bg}`, `--elev:${p.elev}`, `--fg:${p.fg}`, `--muted:${p.muted}`, `--border:${p.border}`,
    `--accent:${p.accent}`, `--hover:${p.hover}`, `--key:${p.key}`, `--str:${p.str}`, `--num:${p.num}`,
    `--bool:${p.bool}`, `--null:${p.nul}`, `--date:${p.date}`, `--anchor:${p.anchor}`, `--alias:${p.alias}`,
    `--tag:${p.tag}`, `--cmt:${p.cmt}`, `--err:${p.err}`, `--warn:${p.warn}`, `--ok:${p.ok}`, `--code:${p.code}`,
    `color-scheme:${p.dark ? 'dark' : 'light'}`,
  ].join(';');
}

/** The light/dark pair a theme belongs to (single-variant themes pair with GitHub). */
function pair(name: ThemeName): { light: ThemeName; dark: ThemeName } {
  const family = name.replace(/-(light|dark)$/, '');
  if (family === 'github' || family === 'one' || family === 'solarized') {
    return { light: `${family}-light` as ThemeName, dark: `${family}-dark` as ThemeName };
  }
  return P[name].dark
    ? { light: 'github-light', dark: name }
    : { light: name, dark: 'github-dark' };
}

export function isThemeName(s: string): s is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(s);
}

/** CSS custom properties for `theme` under the requested colour-scheme mode. */
export function themeCss(theme: string, scheme: ColorScheme): string {
  const name: ThemeName = isThemeName(theme) ? theme : 'github-light';
  if (scheme === 'selectedPreviewTheme') {
    return `:root{${vars(P[name])}}`;
  }
  const { light, dark } = pair(name);
  if (scheme === 'systemColorScheme') {
    return `:root{${vars(P[light])}}@media (prefers-color-scheme: dark){:root{${vars(P[dark])}}}`;
  }
  // editorColorScheme: VS Code marks <body> with vscode-light / vscode-dark …
  return `:root{${vars(P[light])}}body.vscode-dark,body.vscode-high-contrast{${vars(P[dark])}}body.vscode-high-contrast-light{${vars(P[light])}}`;
}

export const BASE_CSS = String.raw`
*{box-sizing:border-box}
html{scroll-behavior:auto}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
code,pre,.row,.code{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
a{color:var(--accent)}
button,select,input{font:inherit;color:inherit}

/* ---- toolbar ---- */
.toolbar{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:6px 12px;background:var(--elev);border-bottom:1px solid var(--border)}
.toolbar .group{display:flex;align-items:center;gap:4px}
.toolbar button,.toolbar select{background:transparent;border:1px solid transparent;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12.5px}
.toolbar button:hover,.toolbar select:hover{background:var(--hover);border-color:var(--border)}
.toolbar button.on,.toolbar button[aria-selected=true]{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.toolbar .views button[aria-selected=true]{font-weight:600}
.toolbar select option{background:var(--bg);color:var(--fg)}
#search{width:200px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:12.5px}
#search:focus{outline:2px solid var(--accent);outline-offset:-1px}
#matchcount{font-size:12px;color:var(--muted);min-width:5ch}
.status{margin-left:auto;font-size:12px;color:var(--muted);display:flex;gap:10px;align-items:center}
.status .bad{color:var(--err);cursor:pointer;font-weight:600}.status .warn{color:var(--warn);cursor:pointer}
body:not(.host) .host-only{display:none}

/* ---- layout ---- */
.layout{display:flex;align-items:flex-start}
#outline{position:sticky;top:var(--toolbar-h,44px);align-self:flex-start;width:236px;flex:none;max-height:calc(100vh - var(--toolbar-h,44px));overflow:auto;padding:10px 8px 40px;border-right:1px solid var(--border);font-size:12.5px}
body.no-outline #outline,body.zen #outline,body.zen .toolbar{display:none}
#outline h4{margin:12px 6px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
#outline ul{list-style:none;margin:0;padding:0}
#outline a{display:flex;align-items:center;gap:6px;padding:2px 6px;border-radius:5px;color:var(--fg);text-decoration:none;cursor:pointer}
#outline a:hover{background:var(--hover)}
#outline a.cur{background:var(--hover);font-weight:600}
#outline .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
#outline .name.anchor{color:var(--anchor)}
#outline .masked .name{opacity:.6}
#outline .count{color:var(--muted);font-size:11px}
#outline .dot{width:7px;height:7px;border-radius:50%;background:var(--err);flex:none}
#outline .none{color:var(--muted);padding:2px 6px}
#outline ul ul{margin-left:11px;padding-left:4px;border-left:1px solid var(--border)}
.ol-document{display:none}body[data-view=document] .ol-document{display:block}body[data-view=document] .ol-tree{display:none}
main{flex:1;min-width:0;padding:14px 26px 120px}
body.zen main{max-width:1000px;margin:0 auto}
@media (max-width:760px){#outline{display:none}main{padding:10px 12px 80px}}

/* ---- documents ---- */
.doc[hidden]{display:none}
.doc-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:2px 0 10px}
.doc-title{margin:0 8px 0 0;font-size:16px}
.doc-comment{margin:0 0 10px;padding:6px 10px;border-left:3px solid var(--border);color:var(--cmt);font-style:italic;white-space:pre-wrap}
.empty{color:var(--muted);padding:18px 4px;font-style:italic}
.notice{margin:8px 0;padding:8px 12px;border-radius:6px;border:1px solid var(--border);background:var(--elev)}
.sev-error{color:var(--err)}.sev-warning{color:var(--warn)}.sev-ok{color:var(--ok)}
.notice.sev-error{border-color:var(--err)}.notice.sev-warning{border-color:var(--warn)}
.view{display:none}
body[data-view=tree] .view-tree,body[data-view=document] .view-document,body[data-view=json] .view-json,body[data-view=resolved] .view-resolved{display:block}
body.loading main{opacity:.55;transition:opacity .15s}

/* ---- chips ---- */
.chip{display:inline-block;font-size:11px;line-height:1.5;padding:0 7px;border-radius:10px;border:1px solid var(--border);background:var(--elev);color:var(--muted);white-space:nowrap}
.chip.stat{font-family:inherit}
.chip.anchor{color:var(--anchor);border-color:currentColor;background:transparent}
.chip.alias{color:var(--alias);border-color:currentColor;background:transparent;text-decoration:none;cursor:pointer}
.chip.alias.bad{color:var(--err)}
.chip.tag{color:var(--tag);background:transparent}
.chip.directive,.chip.blockstyle{color:var(--tag)}
.chip.sev-error{color:var(--err);border-color:var(--err)}.chip.sev-warning{color:var(--warn);border-color:var(--warn)}.chip.sev-ok{color:var(--ok);border-color:var(--ok)}

/* ---- issues ---- */
details.issues{margin:0 0 10px;border:1px solid var(--border);border-radius:8px;background:var(--elev)}
details.issues>summary{cursor:pointer;padding:5px 12px;font-weight:600;color:var(--err)}
details.issues ul{list-style:none;margin:0;padding:0 0 4px}
li.issue{display:flex;gap:10px;padding:3px 12px;cursor:pointer;font-size:12.5px}
li.issue:hover{background:var(--hover)}
li.issue .loc{font-family:ui-monospace,Menlo,Consolas,monospace;color:var(--muted);min-width:6ch}
li.issue .msg{flex:1}
li.issue.sev-error .msg{color:var(--err)}li.issue.sev-warning .msg{color:var(--warn)}
li.issue .src{color:var(--muted);font-size:11.5px}
.issue-badge{font-size:11px;padding:0 6px;border-radius:10px;border:1px solid currentColor;cursor:help}
.issue-badge.sev-error{color:var(--err)}.issue-badge.sev-warning{color:var(--warn)}
.has-issue>.row,tr.has-issue{background:color-mix(in srgb,var(--err) 9%,transparent)}

/* ---- tree ---- */
ul.tree,ul.children{list-style:none;margin:0;padding:0}
ul.children{margin-left:15px;padding-left:12px;border-left:1px solid var(--border)}
.row{display:flex;flex-wrap:wrap;align-items:baseline;gap:1px 7px;padding:1px 6px;border-radius:4px;font-size:12.5px;line-height:1.6}
.row:hover{background:var(--hover)}
summary.row{cursor:pointer;list-style:none}
summary.row::-webkit-details-marker{display:none}
summary.row::before{content:"▸";width:11px;flex:none;color:var(--muted);font-size:11px}
details[open]>summary.row::before{content:"▾"}
li.node:not(.n-map):not(.n-seq)>.row,li.node.n-map:not(:has(>details))>.row,li.node.n-seq:not(:has(>details))>.row{padding-left:23px}
.ln{min-width:3.2ch;text-align:right;color:var(--muted);opacity:.65;cursor:pointer;user-select:none;font-size:11.5px}
.ln:hover{opacity:1;color:var(--accent)}
.label{display:inline-flex;align-items:baseline;gap:5px}
.key{color:var(--key);font-weight:600}
.key.merge{color:var(--alias)}.key.k-int,.key.k-float{color:var(--num)}.key.k-bool{color:var(--bool)}.key.k-complex{color:var(--tag)}
.idx{color:var(--muted)}.idx.root{font-style:italic}
.colon{color:var(--muted)}
.glyph,.meta{color:var(--muted)}
.val{overflow-wrap:anywhere}
.val.str{color:var(--str)}
.val.int,.val.float{color:var(--num)}.val.bool{color:var(--bool)}.val.null{color:var(--null);font-style:italic}.val.timestamp{color:var(--date)}.val.binary,.val.merge{color:var(--tag)}
.val.empty{color:var(--muted)}.val.masked{color:var(--muted);letter-spacing:.1em}
.badge{font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 4px}
.cmt{color:var(--cmt);font-style:italic}
.cmt.trailing{margin-left:4px}
li.cmt-line{padding:1px 6px 1px 25px;font-size:12px;line-height:1.5}
a.link{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
.block{margin:2px 0 6px 56px}
pre.ml{margin:0;padding:7px 11px;background:var(--code);border:1px solid var(--border);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.5}
.val.md{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;color:var(--fg)}
.val.md>:first-child{margin-top:0}.val.md>:last-child{margin-bottom:0}
.thumb{display:inline-block;margin-left:6px;vertical-align:middle;line-height:0}
.thumb img{max-height:34px;max-width:90px;border:1px solid var(--border);border-radius:4px;background:#fff;cursor:zoom-in}
li.node.flash>.row,li.node.flash>details>summary,.blk.flash,tr.flash,h2.flash,h3.flash,h4.flash,h5.flash,h6.flash{animation:flash 1.3s ease-out}
.active>.row,.active>details>summary.row,tr.active,.blk.active{background:color-mix(in srgb,var(--accent) 16%,transparent);box-shadow:inset 3px 0 0 var(--accent)}
.hit>.row,.hit>details>summary.row,tr.hit,.blk.hit{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.hit.cur>.row,.hit.cur>details>summary.row,tr.hit.cur,.blk.hit.cur{outline:2px solid var(--accent);outline-offset:-2px}
.nomatch{display:none!important}
::highlight(yp-match){background:color-mix(in srgb,var(--warn) 45%,transparent);color:inherit}
@keyframes flash{from{background:color-mix(in srgb,var(--accent) 35%,transparent)}to{background:transparent}}

/* ---- tables ---- */
.table-wrap{overflow-x:auto;margin:3px 0 8px 23px;max-width:100%}
table.grid{border-collapse:collapse;font-size:12.5px}
table.grid th,table.grid td{padding:3px 11px;border:1px solid var(--border);text-align:left;vertical-align:top}
table.grid th{background:var(--elev);position:sticky;top:0}
table.grid tbody tr:nth-child(even){background:color-mix(in srgb,var(--elev) 55%,transparent)}
table.grid tbody tr:hover{background:var(--hover)}
table.grid td.idx,table.grid th.idx{color:var(--muted);text-align:right;width:1%}
table.grid td.absent{background:repeating-linear-gradient(135deg,transparent 0 5px,var(--hover) 5px 6px)}

/* ---- code views ---- */
pre.code{margin:0;padding:12px 16px;background:var(--code);border:1px solid var(--border);border-radius:8px;font-size:12.5px;line-height:1.55;overflow:auto;white-space:pre}
.t-key{color:var(--key)}.t-str{color:var(--str)}.t-num{color:var(--num)}.t-bool{color:var(--bool)}.t-null{color:var(--null)}.t-cmt{color:var(--cmt);font-style:italic}.t-tag{color:var(--tag)}

/* ---- document view ---- */
.docview{max-width:940px;font-size:15px;line-height:1.65}
.docview .blk.sec{margin:0}
.dh{margin:1.25em 0 .35em;font-weight:700;line-height:1.3;overflow-wrap:anywhere}
.docview h2.dh{font-size:1.2em}.docview h3.dh{font-size:1.1em}.docview h4.dh,.docview h5.dh,.docview h6.dh{font-size:1em}
.dh.key{color:var(--muted);font-weight:600;text-transform:none}
.docview>.blk.sec>.dh:first-child{margin-top:.4em}
.dh .chip{margin-left:8px;vertical-align:middle;font-weight:400}
.docview .fld{display:flex;flex-wrap:wrap;gap:0 .7em;align-items:baseline;margin:.15em 0;font-size:.95em}
.docview .fk{color:var(--muted);font-size:.85em;min-width:7ch}
.docview .fk.cap{display:block;margin:.6em 0 .1em}
.docview .fv{overflow-wrap:anywhere}
.docview .val.str,.docview .val.int,.docview .val.float,.docview .val.bool{font-family:inherit}
.docview .val.str{color:var(--fg)}
.docview .blk.text{margin:.35em 0}
.docview .md p{margin:.5em 0}.docview .md ul,.docview .md ol{margin:.4em 0;padding-left:1.6em}
.docview .md code,.val.md code{background:var(--code);border:1px solid var(--border);padding:.05em .4em;border-radius:5px;font-size:.86em}
.docview .md pre{background:var(--code);border:1px solid var(--border);border-radius:6px;padding:8px 12px;overflow:auto}
.docview .md pre code{border:0;padding:0;background:transparent}
.docview .md blockquote{margin:.5em 0;padding:0 1em;border-left:3px solid var(--border);color:var(--muted)}
.docview .md table{border-collapse:collapse}.docview .md th,.docview .md td{border:1px solid var(--border);padding:3px 10px}
details.meta-details{margin:.25em 0 .7em}
details.meta-details>summary{cursor:pointer;color:var(--muted);font-size:.95em;list-style:none;display:inline-block;user-select:none}
details.meta-details>summary::-webkit-details-marker{display:none}
details.meta-details>summary::before{content:"▶";display:inline-block;width:1.5em;font-size:.7em;vertical-align:.12em}
details.meta-details[open]>summary::before{content:"▼"}
details.meta-details>summary:hover{color:var(--fg)}
details.meta-details>ul.tree{margin:.3em 0 0 1.1em;padding:.2em .4em;border-left:2px solid var(--border)}
hr.sep{border:0;border-top:1px solid var(--border);margin:1.6em 0}
.item-no{color:var(--muted);font-size:.8em;margin-top:1em}
ul.dl-list{margin:.3em 0;padding-left:1.4em}
.docview .tbl .table-wrap{margin-left:0}

/* ---- PlantUML ---- */
figure.uml{margin:.9em 0;max-width:100%}
.uml-paper{display:inline-block;max-width:100%;overflow:auto;background:#fff;border:1px solid var(--border);border-radius:6px;padding:8px}
.uml-img{display:block;max-width:100%;height:auto;cursor:zoom-in}
.uml-note{font-size:12.5px;color:var(--muted);padding:3px 0}
.uml-note.sev-error{color:var(--err)}.uml-note.sev-warning{color:var(--warn)}
figure.uml.pending .uml-note{animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.4}}
.uml-src{margin-top:3px}
.uml-src>summary{cursor:pointer;font-size:11.5px;color:var(--muted);user-select:none}
.uml-src pre{margin:4px 0 0;padding:8px 12px;background:var(--code);border:1px solid var(--border);border-radius:6px;font-size:12px;overflow:auto}

/* ---- overlays ---- */
#lightbox{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.78);cursor:zoom-out}
#lightbox .paper{max-width:94vw;max-height:92vh;overflow:auto;background:#fff;border-radius:8px;padding:12px}
#lightbox img{display:block;max-width:none}
#ctxmenu{position:fixed;z-index:110;min-width:210px;padding:4px;background:var(--elev);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.35);font-size:12.5px}
#ctxmenu.vscode-theme{background:var(--vscode-menu-background,var(--elev));color:var(--vscode-menu-foreground,var(--fg));border-color:var(--vscode-menu-border,var(--border))}
#ctxmenu button{display:block;width:100%;text-align:left;background:transparent;border:0;border-radius:5px;padding:5px 10px;cursor:pointer}
#ctxmenu button:hover{background:var(--accent);color:var(--bg)}
#ctxmenu.vscode-theme button:hover{background:var(--vscode-menu-selectionBackground,var(--accent));color:var(--vscode-menu-selectionForeground,var(--bg))}
#ctxmenu hr{border:0;border-top:1px solid var(--border);margin:4px 2px}
#zenhint{position:fixed;right:12px;bottom:10px;font-size:11px;color:var(--muted);opacity:.7}
body:not(.zen) #zenhint{display:none}

/* ---- print / export ---- */
body.print .toolbar,body.print #outline,body.print #zenhint{display:none}
body.print main{padding:0}
body.print .doc[hidden]{display:block}
body.print .view{display:none}
body.print[data-view=tree] .view-tree,body.print[data-view=document] .view-document,body.print[data-view=json] .view-json,body.print[data-view=resolved] .view-resolved{display:block}
@media print{.toolbar,#outline,#zenhint,#ctxmenu,#lightbox{display:none!important}main{padding:0}details>*{display:revert}.uml-paper{border-color:#ccc}}
`;
