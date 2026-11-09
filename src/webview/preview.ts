/**
 * Client script for the preview webview and for standalone HTML exports.
 *
 * The same code runs in both places: inside VS Code it talks to the extension
 * host through `acquireVsCodeApi()`; in an exported file there is no host, so
 * the actions that need one (reveal in editor, host-side copy) fall back to
 * browser behaviour or are hidden.
 */
import { toDotPath, toJsonPath } from '../engine/pointer';

type View = 'tree' | 'document' | 'json' | 'resolved';

interface Cfg {
  host: boolean;
  view: View;
  scrollSync: boolean;
  zen: boolean;
  contextMenu: boolean;
  vscodeMenu: boolean;
  lightbox: boolean;
  sortKeys: string;
  diagrams: Record<string, string>;
}

interface VsApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsApi;

const cfg: Cfg = JSON.parse(
  document.getElementById('yp-config')?.textContent || '{}',
);
const api: VsApi | undefined =
  typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

const $ = <T extends HTMLElement = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T | null => root.querySelector<T>(sel);
const $$ = <T extends HTMLElement = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T[] => Array.from(root.querySelectorAll<T>(sel));

const main = $('#content') as HTMLElement;
const outline = $('#outline') as HTMLElement;
const searchInput = $('#search') as HTMLInputElement;
const matchCount = $('#matchcount') as HTMLElement;

const state = {
  view: (document.body.dataset.view as View) || cfg.view || 'tree',
  doc: 0,
  /** Expand/collapse choices the user made, keyed by node, kept across updates. */
  userOpen: new Map<string, boolean>(),
  diagrams: new Map<string, string>(Object.entries(cfg.diagrams ?? {})),
  ignoreScrollUntil: 0,
  query: '',
  hits: [] as HTMLElement[],
  cur: -1,
  pendingNav: undefined as string | undefined,
  lines: [] as Array<{ line: number; el: HTMLElement }>,
};

const post = (message: Record<string, unknown>) => api?.postMessage(message);
const attr = (s: string) => s.replace(/["\\]/g, '\\$&');

function persist() {
  api?.setState({
    zen: document.body.classList.contains('zen'),
    outline: !document.body.classList.contains('no-outline'),
  });
}

/* ------------------------------------------------------------------ */
/* Views & documents                                                   */
/* ------------------------------------------------------------------ */

function activeDoc(): HTMLElement | null {
  return $('section.doc:not([hidden])') ?? $('section.doc');
}

/** Root element of the visible view in the visible document. */
function activeRoot(): HTMLElement | null {
  return $(`.view-${state.view}`, activeDoc() ?? document);
}

function setView(v: View) {
  state.view = v;
  document.body.dataset.view = v;
  for (const b of $$('button[data-view]')) {
    b.setAttribute('aria-selected', String(b.dataset.view === v));
  }
  if (!$(`.view-${v}`)) {
    // Live preview renders only the active view; ask the host for this one.
    if (api) {
      document.body.classList.add('loading');
      post({ command: 'setView', view: v });
    }
    return;
  }
  afterContentChange();
}

function docs(): HTMLElement[] {
  return $$('section.doc');
}

function setDoc(i: number) {
  state.doc = i;
  docs().forEach((d) => {
    d.hidden = Number(d.dataset.doc) !== i;
  });
  $$('.ol-doc').forEach((o) => {
    o.hidden = Number(o.dataset.doc) !== i;
  });
  $$('#doctabs button').forEach((b, idx) =>
    b.setAttribute('aria-selected', String(idx === i)),
  );
  afterContentChange();
}

function buildDocTabs() {
  const el = $('#doctabs');
  if (!el) {
    return;
  }
  el.textContent = '';
  const ds = docs();
  if (ds.length < 2) {
    return;
  }
  ds.forEach((d, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.textContent = d.dataset.label || `Document ${i + 1}`;
    b.title = b.textContent;
    b.setAttribute('aria-selected', String(i === state.doc));
    b.addEventListener('click', () => setDoc(i));
    el.appendChild(b);
  });
}

/* ------------------------------------------------------------------ */
/* Expand / collapse                                                   */
/* ------------------------------------------------------------------ */

function openKey(el: HTMLElement): string | undefined {
  const owner = el.closest<HTMLElement>('[data-ptr]');
  const doc = el.closest<HTMLElement>('section.doc');
  if (!owner || !doc) {
    return undefined;
  }
  return `${doc.dataset.doc}|${el.classList.contains('meta-details') ? 'm' : 't'}|${owner.dataset.ptr}`;
}

/** Set `open` without recording it as a user choice. */
function setOpen(el: HTMLDetailsElement, v: boolean) {
  if (el.open !== v) {
    el.dataset.auto = '1';
    el.open = v;
  }
}

// `toggle` does not bubble, so listen in the capture phase.
main.addEventListener(
  'toggle',
  (e) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== 'DETAILS') {
      return;
    }
    if (el.dataset.auto) {
      delete el.dataset.auto;
      return;
    }
    const key = openKey(el);
    if (key) {
      state.userOpen.set(key, (el as HTMLDetailsElement).open);
    }
  },
  true,
);

function applyUserOpen() {
  for (const d of $$<HTMLDetailsElement>('details', main)) {
    const key = openKey(d);
    if (key && state.userOpen.has(key)) {
      setOpen(d, state.userOpen.get(key)!);
    }
  }
}

function depthOf(el: HTMLElement): number {
  let d = 0;
  for (
    let p = el.parentElement?.closest('details');
    p;
    p = p.parentElement?.closest('details')
  ) {
    d++;
  }
  return d;
}

function setLevel(n: number) {
  state.userOpen.clear();
  const root = activeRoot();
  if (!root) {
    return;
  }
  for (const d of $$<HTMLDetailsElement>(
    'details:not(.issues):not(.uml-src)',
    root,
  )) {
    setOpen(d, depthOf(d) < n);
  }
}
const expandAll = () => setLevel(99);
const collapseAll = () => setLevel(state.view === 'tree' ? 1 : 0);

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/** CSS Custom Highlight API; absent in older engines and in jsdom. */
function highlightRegistry(): Map<string, unknown> | undefined {
  return typeof CSS === 'undefined'
    ? undefined
    : (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
}

function clearHits() {
  for (const el of $$('.hit, .cur, .nomatch', main)) {
    el.classList.remove('hit', 'cur', 'nomatch');
  }
  highlightRegistry()?.delete('yp-match');
  state.hits = [];
  state.cur = -1;
}

/** Text that belongs to a unit itself, excluding nested units. */
function ownNodes(unit: HTMLElement): HTMLElement[] {
  if (unit.matches('li.node')) {
    return $$(':scope > .row, :scope > .block', unit);
  }
  return [unit];
}

function ownText(unit: HTMLElement, tree: boolean): string {
  if (tree) {
    return ownNodes(unit)
      .map((n) => n.textContent ?? '')
      .join(' ');
  }
  // Document view: only leaf units own text; containers match via children.
  return unit.querySelector('[data-ptr]') ? '' : (unit.textContent ?? '');
}

function highlightRanges(roots: HTMLElement[], q: string) {
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown })
    .Highlight;
  const registry = highlightRegistry();
  if (!H || !registry) {
    return;
  }
  const ranges: Range[] = [];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && ranges.length < 2000; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').toLowerCase();
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + q.length);
        ranges.push(r);
      }
    }
  }
  registry.set('yp-match', new H(...ranges));
}

function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  state.query = q;
  clearHits();
  matchCount.textContent = '';
  const root = activeRoot();
  if (!root || !q) {
    return;
  }

  if (state.view === 'json' || state.view === 'resolved') {
    const text = (root.textContent ?? '').toLowerCase();
    let n = 0;
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      n++;
    }
    matchCount.textContent = n ? `${n} match${n === 1 ? '' : 'es'}` : 'none';
    highlightRanges([root], q);
    return;
  }

  const tree = state.view === 'tree';
  const units = $$(tree ? 'li.node, tr[data-ptr]' : '[data-ptr]', root);
  const keep = new Set<HTMLElement>();
  const hits: HTMLElement[] = [];
  for (const u of units) {
    if (ownText(u, tree).toLowerCase().includes(q)) {
      hits.push(u);
      for (
        let a: HTMLElement | null = u;
        a;
        a = a.parentElement?.closest<HTMLElement>('[data-ptr]') ?? null
      ) {
        keep.add(a);
      }
    }
  }
  for (const u of units) {
    if (!keep.has(u)) {
      u.classList.add('nomatch');
    }
  }
  for (const c of $$('li.cmt-line', root)) {
    c.classList.add('nomatch');
  }
  for (const h of hits) {
    h.classList.add('hit');
    for (
      let d = h.closest('details');
      d;
      d = d.parentElement?.closest('details') ?? null
    ) {
      setOpen(d as HTMLDetailsElement, true);
    }
  }
  state.hits = hits;
  matchCount.textContent = hits.length
    ? `${hits.length} match${hits.length === 1 ? '' : 'es'}`
    : 'none';
  highlightRanges(
    hits.flatMap((h) => (tree ? ownNodes(h) : [h])),
    q,
  );
  if (hits.length) {
    stepHit(0, true);
  }
}

function stepHit(dir: number, first = false) {
  if (!state.hits.length) {
    return;
  }
  state.hits[state.cur]?.classList.remove('cur');
  state.cur = first
    ? 0
    : (state.cur + dir + state.hits.length) % state.hits.length;
  const el = state.hits[state.cur];
  el.classList.add('cur');
  el.scrollIntoView({ block: 'center' });
  matchCount.textContent = `${state.cur + 1}/${state.hits.length}`;
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function reveal(el: HTMLElement) {
  for (
    let d = el.closest('details');
    d;
    d = d.parentElement?.closest('details') ?? null
  ) {
    setOpen(d as HTMLDetailsElement, true);
  }
  el.scrollIntoView({ block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

function findByPtr(ptr: string): HTMLElement | null {
  return $(`[data-ptr="${attr(ptr)}"]`, activeRoot() ?? document);
}

/** Jump to a tree node by element id (alias targets always live in the tree). */
function go(id: string) {
  let el = document.getElementById(id);
  if (!el) {
    state.pendingNav = id;
    setView('tree');
    return;
  }
  if (!el.offsetParent && state.view !== 'tree') {
    setView('tree');
    el = document.getElementById(id);
  }
  if (el) {
    reveal(el);
  }
}

function afterContentChange() {
  indexLines();
  if (state.query) {
    runSearch();
  }
  if (state.pendingNav) {
    const id = state.pendingNav;
    state.pendingNav = undefined;
    const el = document.getElementById(id);
    if (el) {
      reveal(el);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scroll sync (editor ⇄ preview)                                      */
/* ------------------------------------------------------------------ */

const headerH = () =>
  document.body.classList.contains('zen')
    ? 0
    : ($('#toolbar')?.offsetHeight ?? 0);

function indexLines() {
  const root = activeRoot();
  state.lines = root
    ? $$('[data-line]', root)
        .map((el) => ({ line: Number(el.dataset.line), el }))
        .filter((x) => x.line > 0)
        .sort((a, b) => a.line - b.line)
    : [];
}

/** The last *visible* element whose source line is ≤ `line`. */
function elementForLine(line: number): HTMLElement | null {
  const a = state.lines;
  let lo = 0;
  let hi = a.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].line <= line) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = best; i >= 0; i--) {
    // Rows that share a start line are in document order (outer → inner), so
    // the last visible one is the most specific.
    if (a[i].el.getClientRects().length > 0) {
      return a[i].el;
    }
  }
  return a.find((x) => x.el.getClientRects().length > 0)?.el ?? null;
}

function setActive(el: HTMLElement | null) {
  for (const a of $$('.active', main)) {
    a.classList.remove('active');
  }
  el?.classList.add('active');
}

function onRevealLine(line: number, mode: 'cursor' | 'scroll') {
  if (mode === 'scroll' && !cfg.scrollSync) {
    return;
  }
  const el = elementForLine(line);
  if (!el) {
    return;
  }
  state.ignoreScrollUntil = Date.now() + 450;
  const rect = el.getBoundingClientRect();
  if (mode === 'cursor') {
    setActive(el.closest<HTMLElement>('li.node, tr, .blk, h2, h3, h4, h5, h6') ?? el);
    if (rect.top < headerH() + 8 || rect.bottom > window.innerHeight - 8) {
      el.scrollIntoView({ block: 'center' });
    }
  } else {
    window.scrollTo({ top: rect.top + window.scrollY - headerH() - 6 });
  }
}

let scrollTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener(
  'scroll',
  () => {
    if (
      !api ||
      !cfg.scrollSync ||
      cfg.sortKeys !== 'none' ||
      Date.now() < state.ignoreScrollUntil
    ) {
      return;
    }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const x = main.getBoundingClientRect().left + 48;
      const el = document
        .elementFromPoint(x, headerH() + 10)
        ?.closest<HTMLElement>('[data-line]');
      const line = window.scrollY <= 2 ? 1 : Number(el?.dataset.line);
      if (line > 0) {
        post({ command: 'scrollLine', line });
      }
    }, 90);
  },
  { passive: true },
);

/* ------------------------------------------------------------------ */
/* Diagrams                                                            */
/* ------------------------------------------------------------------ */

function fillDiagrams() {
  for (const fig of $$('figure.uml.pending[data-uml]')) {
    const html = state.diagrams.get(fig.dataset.uml ?? '');
    if (html !== undefined) {
      fig.classList.remove('pending');
      fig.innerHTML = html;
    }
  }
}

function markAllPending() {
  for (const fig of $$('figure.uml[data-uml]')) {
    fig.classList.add('pending');
    fig.innerHTML = '<div class="uml-note">Rendering diagram…</div>';
  }
}

/* ------------------------------------------------------------------ */
/* Lightbox & context menu                                             */
/* ------------------------------------------------------------------ */

function closeLightbox() {
  $('#lightbox')?.remove();
}

function openLightbox(src: string) {
  closeLightbox();
  const box = document.createElement('div');
  box.id = 'lightbox';
  const paper = document.createElement('div');
  paper.className = 'paper';
  const img = document.createElement('img');
  img.src = src;
  paper.appendChild(img);
  box.appendChild(paper);
  box.addEventListener('click', closeLightbox);
  document.body.appendChild(box);
}

function closeMenu() {
  $('#ctxmenu')?.remove();
}

function copy(text: string) {
  if (api) {
    post({ command: 'copy', text });
    return;
  }
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text);
    return;
  }
  const t = document.createElement('textarea');
  t.value = text;
  document.body.appendChild(t);
  t.select();
  document.execCommand('copy');
  t.remove();
}

interface MenuItem {
  label: string;
  run: () => void;
}

function showMenu(x: number, y: number, items: Array<MenuItem | '-'>) {
  closeMenu();
  const m = document.createElement('div');
  m.id = 'ctxmenu';
  if (cfg.vscodeMenu) {
    m.classList.add('vscode-theme');
  }
  for (const it of items) {
    if (it === '-') {
      m.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.addEventListener('click', () => {
      closeMenu();
      it.run();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
}

document.addEventListener('contextmenu', (e) => {
  if (!cfg.contextMenu) {
    return;
  }
  const t = e.target as HTMLElement;
  if (t.closest('input, select, textarea, #toolbar')) {
    return;
  }
  const items: Array<MenuItem | '-'> = [];
  const fig = t.closest<HTMLElement>('figure.uml[data-uml]');
  const owner = t.closest<HTMLElement>('[data-ptr]');
  const docIdx = Number(t.closest<HTMLElement>('section.doc')?.dataset.doc ?? 0);

  if (fig && !fig.classList.contains('pending')) {
    const hash = fig.dataset.uml;
    const img = $<HTMLImageElement>('img.uml-img', fig);
    if (img) {
      items.push({ label: 'Enlarge diagram', run: () => openLightbox(img.src) });
    }
    if (api) {
      items.push(
        { label: 'Copy PlantUML source', run: () => post({ command: 'copyDiagramSource', hash }) },
        { label: 'Save diagram as SVG…', run: () => post({ command: 'saveDiagram', hash }) },
      );
    }
    items.push('-');
  }
  if (owner && owner.dataset.ptr !== undefined) {
    const ptr = owner.dataset.ptr;
    items.push(
      { label: 'Copy path', run: () => copy(toDotPath(ptr)) },
      { label: 'Copy JSONPath', run: () => copy(toJsonPath(ptr)) },
      { label: 'Copy JSON pointer', run: () => copy(ptr || '/') },
    );
    if (api) {
      items.push(
        { label: 'Copy value as JSON', run: () => post({ command: 'copyValue', doc: docIdx, ptr, format: 'json' }) },
        { label: 'Copy value as YAML', run: () => post({ command: 'copyValue', doc: docIdx, ptr, format: 'yaml' }) },
        '-',
        { label: 'Reveal in editor', run: () => post({ command: 'revealLine', line: Number(owner.dataset.line) }) },
      );
    }
    const details = owner.querySelector<HTMLDetailsElement>(':scope > details');
    if (details) {
      items.push(
        '-',
        { label: 'Expand children', run: () => $$<HTMLDetailsElement>('details', owner).forEach((d) => setOpen(d, true)) },
        { label: 'Collapse children', run: () => $$<HTMLDetailsElement>('details', owner).forEach((d) => d !== details && setOpen(d, false)) },
      );
    }
  }
  if (api) {
    items.push('-', { label: 'Export…', run: () => post({ command: 'export' }) });
  }
  if (items.length === 0) {
    return;
  }
  e.preventDefault();
  showMenu(e.clientX, e.clientY, items);
});

/* ------------------------------------------------------------------ */
/* Clicks & keys                                                       */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('#ctxmenu')) {
    closeMenu();
  }

  // Note: <body> has a data-view attribute too, so match the tab buttons only.
  const view = t.closest<HTMLElement>('button[data-view]');
  if (view) {
    setView(view.dataset.view as View);
    return;
  }
  const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'expand') {
    expandAll();
    return;
  }
  if (act === 'collapse') {
    collapseAll();
    return;
  }
  if (act === 'next' || act === 'prev') {
    stepHit(act === 'next' ? 1 : -1);
    return;
  }
  if (act === 'issues') {
    $('details.issues', activeDoc() ?? document)?.scrollIntoView({ block: 'start' });
    return;
  }
  const opt = t.closest<HTMLElement>('[data-opt]')?.dataset.opt;
  if (opt) {
    post({ command: 'toggleOption', name: opt });
    return;
  }

  const issue = t.closest<HTMLElement>('li.issue[data-line]');
  if (issue) {
    post({ command: 'revealLine', line: Number(issue.dataset.line), col: Number(issue.dataset.col) });
    const ptr = issue.dataset.ptr;
    const target = ptr !== undefined ? findByPtr(ptr) : null;
    if (target) {
      reveal(target);
    }
    return;
  }

  const outlineLink = t.closest<HTMLElement>('#outline a[data-target]');
  if (outlineLink) {
    e.preventDefault();
    const ptr = outlineLink.dataset.ptr;
    const target = ptr !== undefined ? findByPtr(ptr) : null;
    if (target) {
      reveal(target);
    } else {
      go(outlineLink.dataset.target as string);
    }
    return;
  }

  const ln = t.closest<HTMLElement>('.ln[data-line]');
  if (ln) {
    post({ command: 'revealLine', line: Number(ln.dataset.line) });
    return;
  }

  const a = t.closest<HTMLAnchorElement>('a');
  if (a) {
    if (a.classList.contains('alias') && a.dataset.target) {
      e.preventDefault();
      go(a.dataset.target);
      return;
    }
    if (a.classList.contains('thumb')) {
      e.preventDefault();
      if (cfg.lightbox && a.dataset.full) {
        openLightbox(a.dataset.full);
      }
      return;
    }
    const href = a.dataset.href ?? a.getAttribute('href');
    if (href) {
      e.preventDefault();
      if (href.startsWith('#')) {
        go(href.slice(1));
      } else if (api) {
        post({ command: 'openLink', href });
      } else {
        window.open(href, '_blank', 'noopener');
      }
    }
    return;
  }

  if (cfg.lightbox && t.classList.contains('uml-img')) {
    openLightbox((t as HTMLImageElement).src);
  }
});

document.addEventListener('dblclick', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
  if (el && !(e.target as HTMLElement).closest('a, input, #toolbar, #outline')) {
    post({ command: 'revealLine', line: Number(el.dataset.line) });
  }
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;

$('#level')?.addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  if (sel.value) {
    setLevel(Number(sel.value));
    sel.value = '';
  }
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }
  if (e.key === 'Escape') {
    closeMenu();
    closeLightbox();
    if (document.activeElement === searchInput) {
      searchInput.blur();
    } else if (state.query) {
      searchInput.value = '';
      runSearch();
    }
    return;
  }
  const target = e.target as HTMLElement;
  if (target === searchInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepHit(e.shiftKey ? -1 : 1);
    }
    return;
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
    return;
  }
  switch (e.key) {
    case '/':
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      break;
    case 'e':
      expandAll();
      break;
    case 'c':
      collapseAll();
      break;
    case 'n':
      stepHit(1);
      break;
    case 'N':
      stepHit(-1);
      break;
    case 'z':
      if (cfg.zen) {
        document.body.classList.toggle('zen');
        persist();
        indexLines();
      }
      break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        setLevel(Number(e.key));
      }
  }
});

window.addEventListener('blur', closeMenu);
window.addEventListener('resize', () => {
  document.documentElement.style.setProperty('--toolbar-h', `${headerH()}px`);
});
window.addEventListener('beforeprint', () => {
  for (const d of $$<HTMLDetailsElement>('details')) {
    d.open = true;
  }
});

/* ------------------------------------------------------------------ */
/* Messages from the extension host                                    */
/* ------------------------------------------------------------------ */

interface Toggles {
  autoTables: boolean;
  showComments: boolean;
  sortKeys: string;
  markdown: string;
}

function updateToggles(t: Toggles) {
  const set = (name: string, on: boolean, label?: string) => {
    const b = $(`[data-opt="${name}"]`);
    if (b) {
      b.classList.toggle('on', on);
      if (label !== undefined) {
        b.textContent = label;
      }
    }
  };
  set('autoTables', t.autoTables);
  set('showComments', t.showComments);
  set(
    'sortKeys',
    t.sortKeys !== 'none',
    `Sort${t.sortKeys === 'asc' ? ' A→Z' : t.sortKeys === 'desc' ? ' Z→A' : ''}`,
  );
  set('markdown', t.markdown !== 'off', `MD: ${t.markdown}`);
}

interface UpdateMessage {
  command: 'update';
  content: string;
  outline: string;
  status: string;
  view?: View;
  toggles?: Toggles;
  config?: Partial<Cfg>;
}

function applyUpdate(m: UpdateMessage) {
  const keepY = window.scrollY;
  if (m.config) {
    Object.assign(cfg, m.config);
  }
  main.innerHTML = m.content;
  outline.innerHTML = m.outline;
  const status = $('#status');
  if (status) {
    status.innerHTML = m.status;
  }
  if (m.view) {
    state.view = m.view;
    document.body.dataset.view = m.view;
    for (const b of $$('button[data-view]')) {
      b.setAttribute('aria-selected', String(b.dataset.view === m.view));
    }
  }
  if (m.toggles) {
    updateToggles(m.toggles);
  }
  buildDocTabs();
  setDoc(Math.min(state.doc, Math.max(0, docs().length - 1)));
  applyUserOpen();
  fillDiagrams();
  document.body.classList.remove('loading');
  afterContentChange();
  window.scrollTo(0, keepY);
}

window.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data as { command?: string } & Record<string, unknown>;
  switch (m.command) {
    case 'update':
      applyUpdate(m as unknown as UpdateMessage);
      break;
    case 'diagram':
      state.diagrams.set(String(m.hash), String(m.html));
      fillDiagrams();
      break;
    case 'resetDiagrams':
      state.diagrams.clear();
      markAllPending();
      break;
    case 'setView':
      setView(m.view as View);
      break;
    case 'expandAll':
      expandAll();
      break;
    case 'collapseAll':
      collapseAll();
      break;
    case 'focusSearch':
      searchInput.focus();
      searchInput.select();
      break;
    case 'revealLine':
      onRevealLine(Number(m.line), (m.mode as 'cursor' | 'scroll') ?? 'cursor');
      break;
    case 'config':
      Object.assign(cfg, m.config as Partial<Cfg>);
      break;
  }
});

/* ------------------------------------------------------------------ */
/* Start-up                                                            */
/* ------------------------------------------------------------------ */

(function init() {
  const saved = (api?.getState() ?? {}) as { zen?: boolean; outline?: boolean };
  if (saved.zen && cfg.zen) {
    document.body.classList.add('zen');
  }
  if (saved.outline === false) {
    document.body.classList.add('no-outline');
  }
  document.documentElement.style.setProperty('--toolbar-h', `${headerH()}px`);
  buildDocTabs();
  setDoc(0);
  fillDiagrams();
  if (document.body.classList.contains('print')) {
    for (const d of $$<HTMLDetailsElement>('details')) {
      d.open = true;
    }
  }
  indexLines();
  post({ command: 'ready' });
})();
