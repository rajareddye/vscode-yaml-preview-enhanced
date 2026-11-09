const assert = require('assert');
const { JSDOM } = require('jsdom');
const E = require('../out/engine');

// Most tests target the tree; others ask for more views explicitly.
const OPTS = { ...E.DEFAULT_RENDER_OPTIONS, views: ['tree'], markdownKeys: ['description'], protocols: ['http://', 'https://', 'mailto:'] };
const render = (src, o = {}, popts = {}) => {
  const parsed = E.parseYaml(src, popts);
  const r = E.renderPreview(parsed, { ...OPTS, ...o });
  const dom = new JSDOM(`<body><main>${r.content}</main><nav>${r.outline}</nav></body>`);
  return { parsed, r, doc: dom.window.document };
};

suite('engine/render', () => {
  test('every node gets a row with its source line and JSON pointer', () => {
    const { doc } = render('a: 1\nb:\n  c: [x, y]\n');
    const rows = [...doc.querySelectorAll('.view-tree [data-ptr]')];
    const byPtr = Object.fromEntries(rows.map((r) => [r.dataset.ptr, r.dataset.line]));
    assert.deepStrictEqual(byPtr, { '': '1', '/a': '1', '/b': '2', '/b/c': '3', '/b/c/0': '3', '/b/c/1': '3' });
  });

  test('containers are <details>, open up to expandDepth', () => {
    const { doc } = render('a:\n  b:\n    c:\n      d: 1\n', { expandDepth: 2 });
    const open = [...doc.querySelectorAll('.view-tree details')].map((d) => d.open);
    // root(0) open, a(1) open, b(2) closed, c(3) closed
    assert.deepStrictEqual(open, [true, true, false, false]);
  });

  test('plain strings are unquoted, quoted strings keep their quotes', () => {
    const { doc } = render("a: plain\nb: 'sq'\nc: \"dq\"\n");
    const txt = (p) => doc.querySelector(`[data-ptr="${p}"] .val`).textContent;
    assert.deepStrictEqual(['/a', '/b', '/c'].map(txt), ['plain', "'sq'", '"dq"']);
  });

  test('anchors and aliases render as linked chips', () => {
    const { doc } = render('base: &base\n  x: 1\nuse: *base\n');
    assert.ok(doc.querySelector('[data-ptr="/base"] .chip.anchor'));
    const alias = doc.querySelector('[data-ptr="/use"] a.chip.alias');
    assert.strictEqual(alias.textContent, '*base');
    const target = alias.dataset.target;
    assert.ok(doc.getElementById(target), 'alias target id exists in DOM');
    assert.strictEqual(doc.getElementById(target).dataset.ptr, '/base');
  });

  test('unresolved alias is flagged', () => {
    const { doc } = render('a: *ghost\n');
    assert.ok(doc.querySelector('.chip.alias.bad'));
    assert.ok(doc.querySelector('.issues .sev-error'));
  });

  test('list of flat records becomes a table; nested records do not', () => {
    const t = render('items:\n  - {id: 1, name: a}\n  - {id: 2, name: b}\n').doc;
    assert.strictEqual(t.querySelectorAll('table.grid tbody tr').length, 2);
    assert.deepStrictEqual([...t.querySelectorAll('thead th')].map((h) => h.textContent), ['#', 'id', 'name']);
    const n = render('items:\n  - {id: 1, sub: {x: 1}}\n  - {id: 2, sub: {x: 2}}\n').doc;
    assert.strictEqual(n.querySelectorAll('table').length, 0);
    const off = render('items:\n  - {id: 1}\n  - {id: 2}\n', { autoTables: false }).doc;
    assert.strictEqual(off.querySelectorAll('table').length, 0);
    const single = render('items:\n  - {id: 1}\n').doc;
    assert.strictEqual(single.querySelectorAll('table').length, 0);
  });

  test('table rows keep line numbers for scroll sync', () => {
    const { doc } = render('items:\n  - {id: 1}\n  - {id: 2}\n');
    assert.deepStrictEqual([...doc.querySelectorAll('tbody tr')].map((r) => r.dataset.line), ['2', '3']);
  });

  test('sortKeys reorders display but keeps source line numbers', () => {
    const { doc } = render('b: 1\na: 2\nc: 3\n', { sortKeys: 'asc' });
    const rows = [...doc.querySelectorAll('.view-tree ul.children > li')];
    assert.deepStrictEqual(rows.map((r) => r.dataset.ptr), ['/a', '/b', '/c']);
    assert.deepStrictEqual(rows.map((r) => r.dataset.line), ['2', '1', '3']);
    const desc = render('b: 1\na: 2\nc: 3\n', { sortKeys: 'desc' }).doc;
    assert.deepStrictEqual([...desc.querySelectorAll('.view-tree ul.children > li')].map((r) => r.dataset.ptr), ['/c', '/b', '/a']);
  });

  test('maskKeys hides values in the tree, JSON and resolved views', () => {
    const { doc, r } = render('db:\n  user: bob\n  Password: hunter2\ntoken:\n  nested: s3cret\n', { maskKeys: ['pass', 'token'] });
    assert.ok(!r.content.includes('hunter2'));
    assert.ok(!r.content.includes('s3cret'));
    assert.ok(doc.querySelector('[data-ptr="/db/Password"] .masked'));
    assert.ok(doc.querySelector('[data-ptr="/token"] .masked'), 'container under masked key is masked as a whole');
    assert.ok(r.content.includes('bob'));
  });

  test('JSON and resolved views expand anchors and merge keys', () => {
    const { doc } = render('base: &b {a: 1}\nchild:\n  <<: *b\n  c: 2\n', { views: ['json', 'resolved'] });
    const json = JSON.parse(doc.querySelector('.view-json pre').textContent);
    assert.deepStrictEqual(json.child, { a: 1, c: 2 });
    const resolved = doc.querySelector('.view-resolved pre').textContent;
    assert.ok(!resolved.includes('*b') && !resolved.includes('&b'));
    assert.match(resolved, /child:\n {2}a: 1\n {2}c: 2/);
  });

  test('comments render above and trailing, and can be turned off', () => {
    const src = '# about foo\nfoo: 1 # trailing\n';
    assert.ok(render(src).r.content.includes('trailing'));
    const off = render(src, { showComments: false }).r.content;
    assert.ok(!off.includes('trailing') && !off.includes('about foo'));
  });

  test('multi-line strings render as blocks; markdown only when enabled', () => {
    const src = 'description: |\n  # Title\n  some **bold** text\nother: |\n  # Not md\n';
    const off = render(src).doc;
    assert.ok(off.querySelector('[data-ptr="/description"] pre.ml'));
    const by = render(src, { markdown: 'byKey' }).doc;
    assert.ok(by.querySelector('[data-ptr="/description"] .md h1'));
    assert.ok(by.querySelector('[data-ptr="/description"] .md strong'));
    assert.ok(by.querySelector('[data-ptr="/other"] pre.ml'), 'other key stays verbatim in byKey mode');
    const all = render(src, { markdown: 'all' }).doc;
    assert.ok(all.querySelector('[data-ptr="/other"] .md h1'));
  });

  test('multi-document files render one section per doc, later ones hidden', () => {
    const { doc } = render('a: 1\n---\nkind: Pod\nmetadata: {name: p}\n');
    const secs = [...doc.querySelectorAll('section.doc')];
    assert.strictEqual(secs.length, 2);
    assert.strictEqual(secs[1].dataset.label, 'Pod/p');
    assert.ok(secs[1].hidden && !secs[0].hidden);
  });

  test('empty input renders a friendly notice', () => {
    assert.match(render('').r.content, /no YAML documents/);
    assert.match(render('---\n---\na: 1\n').r.content, /Empty document/);
  });

  test('outline lists top-level keys and anchors with usage counts', () => {
    const { doc } = render('base: &base {a: 1}\nx: *base\ny: *base\n');
    const names = [...doc.querySelectorAll('nav .ol-tree .name')].map((n) => n.textContent);
    assert.deepStrictEqual(names, ['base', 'x', 'y']);
    const anchor = doc.querySelector('nav .name.anchor');
    assert.strictEqual(anchor.textContent, '&base');
    assert.strictEqual(anchor.nextElementSibling.textContent, '2');
  });

  test('meta reports counts', () => {
    const { r } = render('a: 1\n---\nb: [1\n');
    assert.strictEqual(r.meta.docCount, 2);
    assert.ok(r.meta.errorCount > 0);
  });

  test('views option renders only the requested views', () => {
    const only = (views) => [...render('a: 1\n', { views }).doc.querySelectorAll('.view')].map((v) => v.className.replace('view view-', ''));
    assert.deepStrictEqual(only(undefined), ['tree', 'document', 'json', 'resolved']);
    assert.deepStrictEqual(only(['tree']), ['tree']);
    assert.deepStrictEqual(only(['document', 'json']), ['document', 'json']);
  });

  test('tree and document views never share element ids', () => {
    const { doc } = render('a: 1\nb:\n  - {x: 1}\n  - {x: 2}\nmetadata:\n  k: v\n', { views: undefined });
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids: ' + ids.filter((x, i) => ids.indexOf(x) !== i));
  });

  test('showTypeBadges and showLineNumbers toggle', () => {
    const on = render('a: 1\n', { showTypeBadges: true }).doc;
    assert.strictEqual(on.querySelector('[data-ptr="/a"] .badge').textContent, 'int');
    const off = render('a: 1\n', { showLineNumbers: false }).doc;
    assert.ok(!off.querySelector('.ln'));
  });
});

suite('engine/render — security', () => {
  const evil = '<script>alert(1)</script>';
  const src = [
    `# ${evil}`,
    `"${evil}": "${evil}" # ${evil}`,
    `tagged: !<${evil}> v`,
    `anchor: &an v`,
    `link: "javascript:alert(1) http://ok.example/a?x=1&y=2"`,
    `img: "<img src=x onerror=alert(1)>.png"`,
    'md: |',
    `  [click](javascript:alert(1)) <b onclick=alert(1)>hi</b> ![i](https://evil.example/p.png)`,
  ].join('\n') + '\n';

  test('no raw markup from the document survives in any mode', () => {
    for (const markdown of ['off', 'all']) {
      const { r } = render(src, { markdown, imagePreview: 'all' });
      const html = r.content + r.outline;
      assert.ok(!/<script/i.test(html), `script tag leaked (${markdown})`);
      assert.ok(!/<img[^>]*onerror/i.test(html), 'onerror attribute leaked');
      // The payload must have reached the renderer (as escaped text), otherwise
      // this test would pass vacuously.
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'payload was not rendered as escaped text');
      assert.ok(!/<b onclick/i.test(html), 'raw html inside markdown leaked');
      assert.ok(!/href="javascript:/i.test(html), 'javascript: link leaked');
    }
  });

  test('parsed DOM contains no script elements or inline handlers', () => {
    const { doc } = render(src, { markdown: 'all', imagePreview: 'all' });
    assert.strictEqual(doc.querySelectorAll('script').length, 0);
    for (const el of doc.querySelectorAll('*')) {
      for (const a of el.attributes) {
        assert.ok(!/^on/i.test(a.name), `inline handler ${a.name} on <${el.tagName}>`);
      }
    }
  });

  test('markdown images are not rendered (no remote loads)', () => {
    const { doc } = render('md: |\n  ![x](https://evil.example/p.png)\n', { markdown: 'all' });
    assert.strictEqual(doc.querySelectorAll('.md img').length, 0);
  });

  test('markdown links outside the whitelist are not linkified', () => {
    const { doc } = render('md: |\n  [a](ftp://x.example) [b](https://ok.example)\n', { markdown: 'all', protocols: ['https://'] });
    const hrefs = [...doc.querySelectorAll('.md a')].map((a) => a.getAttribute('href'));
    assert.deepStrictEqual(hrefs, ['https://ok.example']);
  });

  test('URLs are linkified once-escaped and only for whitelisted protocols', () => {
    const { doc } = render('u: see http://ok.example/a?x=1&y=2. and ftp://nope.example\n');
    const a = doc.querySelector('[data-ptr="/u"] a.link');
    assert.strictEqual(a.getAttribute('href'), 'http://ok.example/a?x=1&y=2');
    assert.strictEqual(doc.querySelectorAll('[data-ptr="/u"] a.link').length, 1);
  });

  test('image thumbnails: remote only with imagePreview=all, local only via resolver', () => {
    const src2 = 'r: https://x.example/a.png\nl: img/b.png\nh: http://x.example/c.png\nd: data:image/png;base64,AAA.png\n';
    const off = render(src2, { imagePreview: 'off' }).doc;
    assert.strictEqual(off.querySelectorAll('img').length, 0);
    const local = render(src2, { imagePreview: 'local', resolveImage: (p) => `vscode-resource://x/${p}` }).doc;
    assert.deepStrictEqual([...local.querySelectorAll('.view-tree img')].map((i) => i.getAttribute('src')), ['vscode-resource://x/img/b.png']);
    const all = render(src2, { imagePreview: 'all', resolveImage: () => undefined }).doc;
    assert.deepStrictEqual([...all.querySelectorAll('.view-tree img')].map((i) => i.getAttribute('src')), ['https://x.example/a.png']);
  });

  test('error messages and schema text are escaped', () => {
    const { r } = render(`a: ${evil}\nb: *${'x<y'}\n`);
    assert.ok(!/<script/i.test(r.content));
  });
});

suite('engine/highlight', () => {
  test('highlightJson escapes and tokenises', () => {
    const h = E.highlightJson('{"a<b": "x&y", "n": 1.5, "t": true, "z": null}');
    assert.ok(h.includes('<span class="t-key">&quot;a&lt;b&quot;</span>'));
    assert.ok(h.includes('<span class="t-str">&quot;x&amp;y&quot;</span>'));
    assert.ok(h.includes('<span class="t-num">1.5</span>'));
    assert.ok(h.includes('<span class="t-bool">true</span>'));
    assert.ok(h.includes('<span class="t-null">null</span>'));
  });
  test('highlightJson does not tokenise numbers inside strings', () => {
    const h = E.highlightJson('{"a": "v 12 true"}');
    assert.ok(!h.includes('t-num') && !h.includes('t-bool'));
  });
  test('highlightYaml keeps the text intact', () => {
    const y = 'a:\n  - b: 1\n  - "q": |\n      x: not a key\n  # c\nz: ~\n';
    const h = E.highlightYaml(y);
    const dom = new JSDOM(`<pre>${h}</pre>`);
    assert.strictEqual(dom.window.document.querySelector('pre').textContent, y);
    assert.ok(!/t-key">x</.test(h), 'content of a block scalar is not highlighted as a key');
  });
});
