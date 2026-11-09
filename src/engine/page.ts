import { esc } from './html';
import type { RenderMeta } from './render';
import { BASE_CSS, ColorScheme, themeCss } from './styles';
import type { ViewName } from './types';

/** Settings the client script reads from `<script id="yp-config">`. */
export interface ClientConfig {
  /** True inside the VS Code webview (messages go to the extension host). */
  host: boolean;
  view: ViewName;
  scrollSync: boolean;
  zen: boolean;
  contextMenu: boolean;
  /** Style the context menu with the VS Code theme instead of the preview's. */
  vscodeMenu: boolean;
  lightbox: boolean;
  sortKeys: string;
  /** hash → inner HTML of a finished diagram (standalone export). */
  diagrams: Record<string, string>;
}

export interface Toggles {
  autoTables: boolean;
  showComments: boolean;
  sortKeys: string;
  markdown: string;
}

export interface PageOptions {
  title: string;
  content: string;
  outline: string;
  meta: RenderMeta;
  theme: string;
  scheme: ColorScheme;
  view: ViewName;
  client: ClientConfig;
  toggles?: Toggles;
  /** Content-Security-Policy parameters (webview only). */
  csp?: { nonce: string; cspSource: string; remoteImages: boolean };
  /** `<script src>` (webview) … */
  scriptSrc?: string;
  /** … or the script's text, inlined (standalone export). */
  inlineScript?: string;
  customCss?: string;
  headHtml?: string;
  /** Print/PDF/image export: hides the chrome, shows everything. */
  print?: boolean;
}

/** JSON that is safe inside a `<script>` element. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const VIEWS: Array<[ViewName, string, string]> = [
  ['tree', 'Tree', 'Collapsible tree'],
  ['document', 'Document', 'Read the file as a document (Markdown text, metadata, diagrams)'],
  ['json', 'JSON', 'Resolved JSON'],
  ['resolved', 'Resolved', 'YAML with anchors, aliases and merge keys expanded'],
];

export function statusHtml(meta: RenderMeta): string {
  const parts: string[] = [];
  if (meta.docCount > 1) {
    parts.push(`<span>${meta.docCount} documents</span>`);
  }
  parts.push(`<span>${meta.nodeCount.toLocaleString('en-US')} nodes</span>`);
  const problems = meta.errorCount + meta.schemaIssueCount;
  if (problems > 0) {
    parts.push(
      `<span class="bad" data-act="issues" title="Jump to the first problem">${problems} problem${problems === 1 ? '' : 's'}</span>`,
    );
  }
  if (meta.warningCount > 0) {
    parts.push(
      `<span class="warn" data-act="issues">${meta.warningCount} warning${meta.warningCount === 1 ? '' : 's'}</span>`,
    );
  }
  return parts.join('');
}

function toolbar(o: PageOptions): string {
  const t = o.toggles;
  const on = (b: boolean) => (b ? ' on' : '');
  return `<header class="toolbar" id="toolbar">
<div class="group views" role="tablist" aria-label="View">${VIEWS.map(
    ([v, label, tip]) =>
      `<button role="tab" data-view="${v}" title="${esc(tip)}" aria-selected="${v === o.view}">${label}</button>`,
  ).join('')}</div>
<div class="group" id="doctabs" role="tablist" aria-label="Documents"></div>
<div class="group tools">
<button data-act="expand" title="Expand all (E)">Expand</button>
<button data-act="collapse" title="Collapse all (C)">Collapse</button>
<select id="level" title="Expand to level (1–9)" aria-label="Expand to level"><option value="">Level…</option>${[1, 2, 3, 4, 5, 6, 7, 8]
    .map((n) => `<option value="${n}">${n}</option>`)
    .join('')}</select>
</div>
<div class="group">
<input id="search" type="search" placeholder="Search keys and values ( / )" aria-label="Search">
<span id="matchcount" aria-live="polite"></span>
<button data-act="prev" title="Previous match (Shift+Enter)">↑</button><button data-act="next" title="Next match (Enter)">↓</button>
</div>
${
  t
    ? `<div class="group host-only">
<button data-opt="autoTables" class="${on(t.autoTables).trim()}" title="Render lists of records as tables">Tables</button>
<button data-opt="showComments" class="${on(t.showComments).trim()}" title="Show YAML comments">Comments</button>
<button data-opt="sortKeys" class="${on(t.sortKeys !== 'none').trim()}" title="Cycle key sorting: none → A→Z → Z→A">Sort${t.sortKeys === 'asc' ? ' A→Z' : t.sortKeys === 'desc' ? ' Z→A' : ''}</button>
<button data-opt="markdown" class="${on(t.markdown !== 'off').trim()}" title="Cycle Markdown rendering in strings: off → by key → all">MD: ${esc(t.markdown)}</button>
</div>`
    : ''
}
<div class="status" id="status">${statusHtml(o.meta)}</div>
</header>`;
}

/** Complete HTML page for the live preview or a standalone export. */
export function buildPage(o: PageOptions): string {
  const nonce = o.csp ? ` nonce="${esc(o.csp.nonce)}"` : '';
  const csp = o.csp
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${o.csp.cspSource} data:${o.csp.remoteImages ? ' https:' : ''}; style-src ${o.csp.cspSource} 'nonce-${o.csp.nonce}'; script-src 'nonce-${o.csp.nonce}'; font-src ${o.csp.cspSource};">`
    : '';
  const script = o.scriptSrc
    ? `<script${nonce} src="${esc(o.scriptSrc)}"></script>`
    : o.inlineScript
      ? `<script${nonce}>${o.inlineScript.replace(/<\/script/gi, '<\\/script')}</script>`
      : '';
  const body = [
    o.client.host ? 'host' : '',
    o.print ? 'print' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}
<title>${esc(o.title)}</title>
<style${nonce}>${themeCss(o.theme, o.scheme)}</style>
<style${nonce}>${BASE_CSS}</style>
${o.customCss ? `<style${nonce}>${o.customCss.replace(/<\/style/gi, '<\\/style')}</style>` : ''}
${o.headHtml ?? ''}
</head>
<body data-view="${o.view}" class="${body}">
${toolbar(o)}
<div class="layout">
<aside id="outline" aria-label="Outline">${o.outline}</aside>
<main id="content">${o.content}</main>
</div>
<div id="zenhint">Zen mode — press Z to exit</div>
<script type="application/json" id="yp-config">${safeJson(o.client)}</script>
${script}
</body>
</html>`;
}
