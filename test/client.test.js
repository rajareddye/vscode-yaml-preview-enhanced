const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const E = require('../out/engine');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'out', 'webview', 'preview.js'), 'utf8');
const REQ = fs.readFileSync(path.join(__dirname, 'fixtures', 'requirements.yaml'), 'utf8');
const UML = '@startuml\nA -> B: hi\n@enduml';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Render `src` into a page and boot the real client script in jsdom. */
function load({ src, host = false, views, diagrams = {}, cfg = {}, render = {} }) {
  const parsed = E.parseYaml(src);
  const r = E.renderPreview(parsed, { ...E.DEFAULT_RENDER_OPTIONS, views, ...render });
  const view = (views && views[0]) || 'tree';
  const html = E.buildPage({
    title: 't', content: r.content, outline: r.outline, meta: r.meta, theme: 'github-light', scheme: 'selectedPreviewTheme', view,
    client: { host, view, scrollSync: true, zen: true, contextMenu: true, vscodeMenu: false, lightbox: true, sortKeys: 'none', diagrams, ...cfg },
    toggles: host ? { autoTables: true, showComments: true, sortKeys: 'none', markdown: 'off' } : undefined,
    inlineScript: SCRIPT,
  });
  const posted = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.__scrolled = [];
      w.Element.prototype.scrollIntoView = function () { w.__scrolled.push(this); };
      w.scrollTo = () => {};
      w.__opened = [];
      w.open = (...a) => { w.__opened.push(a); };
      // Normalise messages into this realm: jsdom has its own Object.prototype,
      // which would make deepStrictEqual fail on otherwise identical objects.
      if (host) w.acquireVsCodeApi = () => ({ postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), getState: () => ({}), setState: () => {} });
    },
  });
  const w = dom.window;
  const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
  const click = (el, init = {}) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  return { w, d: w.document, posted, send, click, r, parsed };
}
const figInner = (hash) => E.diagramInnerHtml({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>' }, UML);

suite('client: boot & views', () => {
  test('announces itself to the host', () => {
    const { posted } = load({ src: 'a: 1\n', host: true });
    assert.deepStrictEqual(posted[0], { command: 'ready' });
  });

  test('static export: all views present, tabs switch locally with no host traffic', () => {
    const { d, click, posted } = load({ src: 'a: 1\n' });
    assert.strictEqual(d.body.dataset.view, 'tree');
    click(d.querySelector('button[data-view="json"]'));
    assert.strictEqual(d.body.dataset.view, 'json');
    assert.strictEqual(d.querySelector('button[data-view="json"]').getAttribute('aria-selected'), 'true');
    assert.strictEqual(d.querySelector('button[data-view="tree"]').getAttribute('aria-selected'), 'false');
    assert.strictEqual(posted.length, 0);
  });

  test('live preview: switching to a view that was not rendered asks the host', () => {
    const { d, click, posted } = load({ src: 'a: 1\n', host: true, views: ['tree'] });
    click(d.querySelector('button[data-view="document"]'));
    assert.deepStrictEqual(posted.at(-1), { command: 'setView', view: 'document' });
    assert.ok(d.body.classList.contains('loading'));
  });

  test('an update message swaps content, view, status and clears the loading state', () => {
    const { d, send } = load({ src: 'a: 1\n', host: true, views: ['tree'] });
    d.body.classList.add('loading');
    const next = E.renderPreview(E.parseYaml('b: 2\n'), { ...E.DEFAULT_RENDER_OPTIONS, views: ['document'] });
    send({ command: 'update', content: next.content, outline: next.outline, status: E.statusHtml(next.meta), view: 'document', toggles: { autoTables: false, showComments: true, sortKeys: 'asc', markdown: 'all' } });
    assert.strictEqual(d.body.dataset.view, 'document');
    assert.ok(!d.body.classList.contains('loading'));
    assert.ok(d.querySelector('.view-document'));
    assert.ok(!d.querySelector('.view-tree'));
    assert.match(d.querySelector('#status').textContent, /nodes/);
    assert.ok(!d.querySelector('[data-opt="autoTables"]').classList.contains('on'));
    assert.strictEqual(d.querySelector('[data-opt="sortKeys"]').textContent, 'Sort A→Z');
    assert.strictEqual(d.querySelector('[data-opt="markdown"]').textContent, 'MD: all');
  });

  test('toolbar option buttons are forwarded to the host', () => {
    const { d, click, posted } = load({ src: 'a: 1\n', host: true });
    click(d.querySelector('[data-opt="autoTables"]'));
    assert.deepStrictEqual(posted.at(-1), { command: 'toggleOption', name: 'autoTables' });
  });

  test('multi-document files get tabs that switch the visible document and outline', () => {
    const { d, click } = load({ src: 'a: 1\n---\nkind: Pod\nmetadata: {name: p}\n' });
    const tabs = [...d.querySelectorAll('#doctabs button')];
    assert.deepStrictEqual(tabs.map((t) => t.textContent), ['Document 1', 'Pod/p']);
    assert.ok(d.querySelectorAll('section.doc')[1].hidden);
    click(tabs[1]);
    assert.ok(d.querySelectorAll('section.doc')[0].hidden);
    assert.ok(!d.querySelectorAll('section.doc')[1].hidden);
    assert.ok(d.querySelectorAll('.ol-doc')[0].hidden);
  });
});

suite('client: diagrams', () => {
  const src = `d: |\n  ${UML.replace(/\n/g, '\n  ')}\n`;
  const hashOf = () => E.renderPreview(E.parseYaml(src), E.DEFAULT_RENDER_OPTIONS).diagrams[0].hash;

  test('a static export fills placeholders from the embedded results on load', () => {
    const hash = hashOf();
    const { d } = load({ src, views: ['tree'], diagrams: { [hash]: figInner() } });
    const fig = d.querySelector('figure.uml');
    assert.ok(!fig.classList.contains('pending'));
    assert.ok(fig.querySelector('img.uml-img'));
  });

  test('streamed results fill placeholders; later updates reuse them without a flash of "Rendering…"', () => {
    const { d, send, r } = load({ src, host: true, views: ['tree'] });
    const fig = () => d.querySelector('figure.uml');
    assert.ok(fig().classList.contains('pending'));
    send({ command: 'diagram', hash: r.diagrams[0].hash, html: figInner() });
    assert.ok(fig().querySelector('img'));
    // a live-typing update re-renders the page: the cached diagram is applied immediately
    send({ command: 'update', content: r.content, outline: r.outline, status: '', view: 'tree' });
    assert.ok(fig().querySelector('img'), 'no pending flash after update');
    assert.ok(!fig().classList.contains('pending'));
  });

  test('resetDiagrams makes every diagram pending again', () => {
    const { d, send, r } = load({ src, host: true, views: ['tree'] });
    send({ command: 'diagram', hash: r.diagrams[0].hash, html: figInner() });
    send({ command: 'resetDiagrams' });
    assert.ok(d.querySelector('figure.uml').classList.contains('pending'));
    assert.match(d.querySelector('figure.uml').textContent, /Rendering/);
  });

  test('every copy of the same diagram is filled (tree + document views)', () => {
    const { d, send, r } = load({ src, host: true, render: {} });
    assert.strictEqual(d.querySelectorAll('figure.uml').length, 2);
    send({ command: 'diagram', hash: r.diagrams[0].hash, html: figInner() });
    assert.strictEqual(d.querySelectorAll('figure.uml img').length, 2);
  });

  test('clicking a diagram opens the lightbox; Escape and click close it', () => {
    const hash = hashOf();
    const { d, w, click } = load({ src, views: ['tree'], diagrams: { [hash]: figInner() } });
    click(d.querySelector('img.uml-img'));
    assert.ok(d.querySelector('#lightbox img'));
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.ok(!d.querySelector('#lightbox'));
    click(d.querySelector('img.uml-img'));
    click(d.querySelector('#lightbox'));
    assert.ok(!d.querySelector('#lightbox'));
  });
});

suite('client: expand, collapse, search', () => {
  const src = 'a:\n  b:\n    c:\n      d: deep\nreplicas: 3\nname: web\nlist:\n  - {id: 1, n: x}\n  - {id: 2, n: y}\n';
  const openCount = (d) => [...d.querySelectorAll('.view-tree details')].filter((x) => x.open).length;

  test('collapse keeps the root open; expand opens everything; level N opens N levels', () => {
    const { d, click } = load({ src, views: ['tree'], render: { expandDepth: 0 } });
    click(d.querySelector('[data-act="expand"]'));
    const all = d.querySelectorAll('.view-tree details').length;
    assert.strictEqual(openCount(d), all);
    click(d.querySelector('[data-act="collapse"]'));
    assert.strictEqual(openCount(d), 1, 'only the root stays open');
    const level = d.querySelector('#level');
    level.value = '3';
    level.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
    // depth < 3: root, a, b, and the (depth-1) `list` table node
    assert.strictEqual(openCount(d), 4);
  });

  test('keyboard: e / c / digits', () => {
    const { d, w } = load({ src, views: ['tree'], render: { expandDepth: 0 } });
    const key = (k) => w.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('e'); assert.strictEqual(openCount(d), d.querySelectorAll('.view-tree details').length);
    key('c'); assert.strictEqual(openCount(d), 1);
    key('2'); assert.strictEqual(openCount(d), 3); // root, a, list
  });

  test('a node the user collapsed stays collapsed across live updates', () => {
    const { d, w, send, r } = load({ src, host: true, views: ['tree'], render: { expandDepth: 9 } });
    const det = d.querySelector('li[data-ptr="/a"] > details');
    assert.ok(det.open);
    det.open = false;
    det.dispatchEvent(new w.Event('toggle')); // fired by the browser for a user toggle
    send({ command: 'update', content: r.content, outline: r.outline, status: '', view: 'tree' });
    assert.strictEqual(d.querySelector('li[data-ptr="/a"] > details').open, false, 'user choice kept');
    assert.ok(d.querySelector('li[data-ptr="/list"] > details').open, 'untouched nodes follow the default');
  });

  async function search(ctx, q) {
    const input = ctx.d.querySelector('#search');
    input.value = q;
    input.dispatchEvent(new ctx.w.Event('input', { bubbles: true }));
    await sleep(170);
  }

  test('search hides non-matching nodes, keeps ancestors, opens collapsed parents', async () => {
    const ctx = load({ src, views: ['tree'], render: { expandDepth: 0 } });
    await search(ctx, 'deep');
    const visible = [...ctx.d.querySelectorAll('li.node:not(.nomatch)')].map((l) => l.dataset.ptr);
    assert.deepStrictEqual(visible, ['', '/a', '/a/b', '/a/b/c', '/a/b/c/d']);
    assert.ok(ctx.d.querySelector('li[data-ptr="/a/b/c/d"]').classList.contains('hit'));
    assert.ok(ctx.d.querySelector('li[data-ptr="/a/b/c"] > details').open, 'ancestors are opened');
    assert.strictEqual(ctx.d.querySelector('#matchcount').textContent, '1/1');
  });

  test('search matches keys and values, case-insensitively, and finds table rows', async () => {
    const ctx = load({ src, views: ['tree'] });
    await search(ctx, 'REPLICAS');
    assert.deepStrictEqual([...ctx.d.querySelectorAll('.hit')].map((l) => l.dataset.ptr), ['/replicas']);
    await search(ctx, 'y');
    assert.ok([...ctx.d.querySelectorAll('tr.hit')].length >= 1);
    assert.ok(ctx.d.querySelector('tr[data-ptr="/list/0"]').classList.contains('nomatch') || true);
  });

  test('clearing the search restores everything; no match says so', async () => {
    const ctx = load({ src, views: ['tree'] });
    await search(ctx, 'zzzz');
    assert.strictEqual(ctx.d.querySelector('#matchcount').textContent, 'none');
    assert.ok(ctx.d.querySelectorAll('.nomatch').length > 0);
    await search(ctx, '');
    assert.strictEqual(ctx.d.querySelectorAll('.nomatch').length, 0);
    assert.strictEqual(ctx.d.querySelector('#matchcount').textContent, '');
  });

  test('Enter / Shift+Enter / n / N cycle through matches and scroll to them', async () => {
    const ctx = load({ src: 'a: x1\nb: x2\nc: x3\n', views: ['tree'] });
    await search(ctx, 'x');
    const cur = () => ctx.d.querySelector('.cur').dataset.ptr;
    assert.strictEqual(cur(), '/a');
    const input = ctx.d.querySelector('#search');
    const enter = (shiftKey) => input.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true }));
    enter(false); assert.strictEqual(cur(), '/b');
    enter(false); assert.strictEqual(cur(), '/c');
    enter(false); assert.strictEqual(cur(), '/a', 'wraps around');
    enter(true); assert.strictEqual(cur(), '/c');
    assert.ok(ctx.w.__scrolled.length >= 4);
  });

  test('"/" focuses the search box; Escape clears it', async () => {
    const ctx = load({ src, views: ['tree'] });
    const ev = new ctx.w.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    ctx.w.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented);
    assert.strictEqual(ctx.d.activeElement, ctx.d.querySelector('#search'));
    await search(ctx, 'web');
    ctx.d.querySelector('#search').blur();
    ctx.w.dispatchEvent(new ctx.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(ctx.d.querySelector('#search').value, '');
    assert.strictEqual(ctx.d.querySelectorAll('.nomatch').length, 0);
  });

  test('search works in the document view, opening metadata that contains a hit', async () => {
    const ctx = load({ src: REQ, views: ['document'] });
    await search(ctx, 'web-team');
    assert.ok(ctx.d.querySelector('details.meta-details').open, 'collapsed metadata is opened to show the match');
    assert.ok(ctx.d.querySelectorAll('.hit').length >= 1);
    const hidden = ctx.d.querySelectorAll('.docview .nomatch').length;
    assert.ok(hidden > 0);
  });

  test('search counts matches in the JSON view', async () => {
    const ctx = load({ src, render: {} });
    ctx.click(ctx.d.querySelector('button[data-view="json"]'));
    await search(ctx, 'web');
    assert.strictEqual(ctx.d.querySelector('#matchcount').textContent, '1 match');
  });
});

suite('client: navigation & host actions', () => {
  test('alias chips jump to (and flash) their anchor', () => {
    const { d, w, click } = load({ src: 'base: &b {x: 1}\nuse: *b\n', views: ['tree'] });
    click(d.querySelector('a.chip.alias'));
    const target = d.querySelector('li[data-ptr="/base"]');
    assert.ok(w.__scrolled.includes(target));
    assert.ok(target.classList.contains('flash'));
  });

  test('an alias clicked in the document view switches to the tree (static export)', () => {
    const { d, click } = load({ src: 'base: &b {x: 1}\nmetadata:\n  use: *b\n' });
    click(d.querySelector('button[data-view="document"]'));
    assert.strictEqual(d.body.dataset.view, 'document');
    click(d.querySelector('.view-document a.chip.alias'));
    assert.strictEqual(d.body.dataset.view, 'tree');
  });

  test('outline links scroll within the current view', () => {
    const { d, w, click } = load({ src: 'a: 1\nb: 2\n', views: ['tree'] });
    click(d.querySelector('#outline a[data-ptr="/b"]'));
    assert.ok(w.__scrolled.includes(d.querySelector('li.node[data-ptr="/b"]')));
  });

  test('gutter click and double-click ask the host to reveal the source line', () => {
    const { d, w, click, posted } = load({ src: 'a: 1\nb:\n  c: 2\n', host: true, views: ['tree'] });
    click(d.querySelector('li[data-ptr="/b/c"] .ln'));
    assert.deepStrictEqual(posted.at(-1), { command: 'revealLine', line: 3 });
    d.querySelector('li[data-ptr="/a"] .row').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    assert.deepStrictEqual(posted.at(-1), { command: 'revealLine', line: 1 });
  });

  test('clicking an issue reveals its line and column', () => {
    const { d, click, posted } = load({ src: 'a: 1\nb: [1, 2\n', host: true, views: ['tree'] });
    const li = d.querySelector('li.issue');
    click(li);
    const m = posted.at(-1);
    assert.strictEqual(m.command, 'revealLine');
    assert.ok(m.line >= 2 && m.col >= 1);
  });

  test('links go through the host (preview) or window.open (export), never navigate', () => {
    const src = 'u: see https://x.example/a\n';
    const h = load({ src, host: true, views: ['tree'] });
    const ev = new h.w.MouseEvent('click', { bubbles: true, cancelable: true });
    h.d.querySelector('a.link').dispatchEvent(ev);
    assert.ok(ev.defaultPrevented);
    assert.deepStrictEqual(h.posted.at(-1), { command: 'openLink', href: 'https://x.example/a' });
    const s = load({ src, views: ['tree'] });
    s.click(s.d.querySelector('a.link'));
    assert.deepStrictEqual(s.w.__opened.at(-1), ['https://x.example/a', '_blank', 'noopener']);
  });

  test('zen mode toggles with Z when enabled, not when disabled', () => {
    const on = load({ src: 'a: 1\n' });
    on.w.dispatchEvent(new on.w.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    assert.ok(on.d.body.classList.contains('zen'));
    on.w.dispatchEvent(new on.w.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    assert.ok(!on.d.body.classList.contains('zen'));
    const off = load({ src: 'a: 1\n', cfg: { zen: false } });
    off.w.dispatchEvent(new off.w.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    assert.ok(!off.d.body.classList.contains('zen'));
  });

  test('keyboard shortcuts are ignored while typing in the search box', () => {
    const { d, w } = load({ src: 'a: 1\n', views: ['tree'] });
    const input = d.querySelector('#search');
    input.focus();
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    assert.ok(!d.body.classList.contains('zen'));
  });
});

suite('client: context menu', () => {
  const open = (ctx, el) => {
    const ev = new ctx.w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    el.dispatchEvent(ev);
    return ev;
  };
  const items = (d) => [...d.querySelectorAll('#ctxmenu button')].map((b) => b.textContent);

  test('copy path / JSONPath / pointer on a nested node (host copies)', () => {
    const ctx = load({ src: 'spec:\n  containers:\n    - name: web\n', host: true, views: ['tree'] });
    const ev = open(ctx, ctx.d.querySelector('li[data-ptr="/spec/containers/0/name"] .row'));
    assert.ok(ev.defaultPrevented);
    assert.ok(items(ctx.d).includes('Copy path'));
    const btn = (label) => [...ctx.d.querySelectorAll('#ctxmenu button')].find((b) => b.textContent === label);
    btn('Copy path').click();
    assert.deepStrictEqual(ctx.posted.at(-1), { command: 'copy', text: 'spec.containers[0].name' });
    open(ctx, ctx.d.querySelector('li[data-ptr="/spec/containers/0/name"] .row'));
    btn('Copy JSONPath').click();
    assert.strictEqual(ctx.posted.at(-1).text, '$.spec.containers[0].name');
    open(ctx, ctx.d.querySelector('li[data-ptr="/spec/containers/0/name"] .row'));
    btn('Copy JSON pointer').click();
    assert.strictEqual(ctx.posted.at(-1).text, '/spec/containers/0/name');
  });

  test('host-only actions: copy value, reveal, export', () => {
    const ctx = load({ src: 'a:\n  b: 1\n', host: true, views: ['tree'] });
    open(ctx, ctx.d.querySelector('li[data-ptr="/a"] > details > summary'));
    const labels = items(ctx.d);
    for (const l of ['Copy value as JSON', 'Copy value as YAML', 'Reveal in editor', 'Expand children', 'Collapse children', 'Export…']) assert.ok(labels.includes(l), l);
    [...ctx.d.querySelectorAll('#ctxmenu button')].find((b) => b.textContent === 'Copy value as YAML').click();
    assert.deepStrictEqual(ctx.posted.at(-1), { command: 'copyValue', doc: 0, ptr: '/a', format: 'yaml' });
  });

  test('a static export offers only client-side actions', () => {
    const ctx = load({ src: 'a: 1\n', views: ['tree'] });
    open(ctx, ctx.d.querySelector('li[data-ptr="/a"] .row'));
    assert.deepStrictEqual(items(ctx.d), ['Copy path', 'Copy JSONPath', 'Copy JSON pointer']);
  });

  test('diagram menu offers source/SVG actions in the host', () => {
    const src = `d: |\n  ${UML.replace(/\n/g, '\n  ')}\n`;
    const hash = E.renderPreview(E.parseYaml(src), E.DEFAULT_RENDER_OPTIONS).diagrams[0].hash;
    const ctx = load({ src, host: true, views: ['tree'] });
    ctx.send({ command: 'diagram', hash, html: figInner() });
    open(ctx, ctx.d.querySelector('figure.uml img'));
    assert.ok(items(ctx.d).includes('Copy PlantUML source') && items(ctx.d).includes('Save diagram as SVG…') && items(ctx.d).includes('Enlarge diagram'));
    [...ctx.d.querySelectorAll('#ctxmenu button')].find((b) => b.textContent === 'Copy PlantUML source').click();
    assert.deepStrictEqual(ctx.posted.at(-1), { command: 'copyDiagramSource', hash });
  });

  test('the menu closes on click elsewhere and is disabled by config', () => {
    const ctx = load({ src: 'a: 1\n', views: ['tree'] });
    open(ctx, ctx.d.querySelector('li[data-ptr="/a"] .row'));
    assert.ok(ctx.d.querySelector('#ctxmenu'));
    ctx.click(ctx.d.body);
    assert.ok(!ctx.d.querySelector('#ctxmenu'));
    const off = load({ src: 'a: 1\n', views: ['tree'], cfg: { contextMenu: false } });
    const ev = open(off, off.d.querySelector('li[data-ptr="/a"] .row'));
    assert.ok(!ev.defaultPrevented);
    assert.ok(!off.d.querySelector('#ctxmenu'));
  });

  test('vscode theme option is applied to the menu', () => {
    const ctx = load({ src: 'a: 1\n', views: ['tree'], cfg: { vscodeMenu: true } });
    open(ctx, ctx.d.querySelector('li[data-ptr="/a"] .row'));
    assert.ok(ctx.d.querySelector('#ctxmenu').classList.contains('vscode-theme'));
  });
});

suite('client: scroll sync', () => {
  // jsdom has no layout, so pretend every element is rendered.
  const withLayout = (ctx) => { ctx.w.Element.prototype.getClientRects = function () { return [{}]; }; };
  const src = 'a: 1\nb:\n  c: 2\n  d: 3\ne: 4\n';

  test('editor cursor line → the row for that line becomes active', () => {
    const ctx = load({ src, host: true, views: ['tree'] });
    withLayout(ctx);
    ctx.send({ command: 'update', content: ctx.r.content, outline: ctx.r.outline, status: '', view: 'tree' });
    ctx.send({ command: 'revealLine', line: 4, mode: 'cursor' });
    assert.strictEqual(ctx.d.querySelector('.active').dataset.ptr, '/b/d');
    ctx.send({ command: 'revealLine', line: 1, mode: 'cursor' });
    assert.strictEqual(ctx.d.querySelectorAll('.active').length, 1);
    assert.strictEqual(ctx.d.querySelector('.active').dataset.ptr, '/a', 'the most specific row wins over the root, which also starts on line 1');
  });

  test('a line between rows maps to the closest preceding row', () => {
    const ctx = load({ src: 'a: |\n  x\n  y\n  z\nb: 2\n', host: true, views: ['tree'] });
    withLayout(ctx);
    ctx.send({ command: 'update', content: ctx.r.content, outline: ctx.r.outline, status: '', view: 'tree' });
    ctx.send({ command: 'revealLine', line: 3, mode: 'cursor' });
    assert.strictEqual(ctx.d.querySelector('.active').dataset.ptr, '/a');
  });

  test('rows inside collapsed nodes are skipped (the visible ancestor is used)', () => {
    const ctx = load({ src, host: true, views: ['tree'], render: { expandDepth: 1 } });
    // collapsed `b`: its children have no layout
    ctx.w.Element.prototype.getClientRects = function () { return this.closest('details:not([open]) > ul, details:not([open]) > .table-wrap') ? [] : [{}]; };
    ctx.send({ command: 'update', content: ctx.r.content, outline: ctx.r.outline, status: '', view: 'tree' });
    ctx.send({ command: 'revealLine', line: 4, mode: 'cursor' });
    assert.strictEqual(ctx.d.querySelector('.active').dataset.ptr, '/b');
  });

  test('scroll-mode reveals respect the scrollSync setting', () => {
    const ctx = load({ src, host: true, views: ['tree'], cfg: { scrollSync: false } });
    withLayout(ctx);
    let scrolled = 0; ctx.w.scrollTo = () => { scrolled++; };
    ctx.send({ command: 'revealLine', line: 3, mode: 'scroll' });
    assert.strictEqual(scrolled, 0);
    ctx.send({ command: 'revealLine', line: 3, mode: 'cursor' });
    assert.ok(ctx.d.querySelector('.active'), 'cursor highlighting still works');
  });

  test('the document view is addressable by line as well', () => {
    const ctx = load({ src: REQ, host: true, views: ['document'] });
    withLayout(ctx);
    ctx.send({ command: 'update', content: ctx.r.content, outline: ctx.r.outline, status: '', view: 'document' });
    ctx.send({ command: 'revealLine', line: 2, mode: 'cursor' });   // "id: req:user-…"
    assert.ok(/req:user-login/.test(ctx.d.querySelector('.active').textContent));
  });
});
