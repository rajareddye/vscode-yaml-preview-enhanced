const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const E = require('../out/engine');

const render = (src, o = {}) => {
  const parsed = E.parseYaml(src);
  const r = E.renderPreview(parsed, { ...E.DEFAULT_RENDER_OPTIONS, views: ['tree'], ...o });
  return { r, doc: new JSDOM(`<body>${r.content}</body>`).window.document };
};
const UML = '@startuml\nA -> B: hi\n@enduml';

suite('plantuml/split', () => {
  test('finds blocks and keeps the text around them', () => {
    const segs = E.splitPlantUml(`before\n${UML}\nbetween\n@startmindmap\n* r\n@endmindmap\nafter`);
    assert.deepStrictEqual(segs.map((s) => s.type === 'uml' ? `uml:${s.kind}` : `text:${s.text}`), ['text:before', 'uml:uml', 'text:between', 'uml:mindmap', 'text:after']);
    assert.strictEqual(segs[1].source, UML);
  });
  test('an unclosed @startuml stays plain text', () => {
    const segs = E.splitPlantUml('@startuml\nA -> B\nno end');
    assert.deepStrictEqual(segs.map((s) => s.type), ['text']);
    assert.strictEqual(E.containsPlantUml('@startuml\nA -> B'), false);
  });
  test('start/end must match, and indentation is removed', () => {
    assert.strictEqual(E.containsPlantUml('@startuml\nA->B\n@endmindmap'), false);
    const [s] = E.splitPlantUml('    @startuml\n      A -> B\n    @enduml');
    assert.strictEqual(s.source, '@startuml\n  A -> B\n@enduml');
  });
  test('ensureStart wraps bare bodies only', () => {
    assert.strictEqual(E.ensureStart('A -> B\n'), '@startuml\nA -> B\n@enduml');
    assert.strictEqual(E.ensureStart(UML), UML);
    assert.strictEqual(E.ensureStart('@startgantt\n[T] lasts 2 days\n@endgantt'), '@startgantt\n[T] lasts 2 days\n@endgantt');
  });
  test('hashString is deterministic and discriminating', () => {
    assert.strictEqual(E.hashString('abc'), E.hashString('abc'));
    assert.notStrictEqual(E.hashString('abc'), E.hashString('abd'));
    assert.notStrictEqual(E.hashString('a'), E.hashString('a '));
    assert.match(E.hashString('x'), /^[0-9a-z]+$/);
  });
});

suite('plantuml/tree view', () => {
  test('a multi-line string with @startuml becomes a placeholder; surrounding text stays', () => {
    const { r, doc } = render(`note: |\n  Intro text\n  ${UML.replace(/\n/g, '\n  ')}\n  Outro text\n`);
    assert.strictEqual(doc.querySelectorAll('figure.uml.pending').length, 1);
    const pres = [...doc.querySelectorAll('pre.ml')].map((p) => p.textContent);
    assert.deepStrictEqual(pres, ['Intro text', 'Outro text']);
    assert.strictEqual(r.diagrams.length, 1);
    assert.strictEqual(r.diagrams[0].source, UML);
    assert.strictEqual(doc.querySelector('figure').dataset.uml, r.diagrams[0].hash);
  });

  test('the diagram source never appears in the placeholder markup', () => {
    const { r } = render(`d: |\n  ${UML.replace(/\n/g, '\n  ')}\n`);
    assert.ok(!r.content.includes('A -&gt; B'), 'source must not be duplicated into the page');
  });

  test('identical diagrams share one hash / one render request', () => {
    const { r, doc } = render(`a: |\n  ${UML.replace(/\n/g, '\n  ')}\nb: |\n  ${UML.replace(/\n/g, '\n  ')}\n`);
    assert.strictEqual(doc.querySelectorAll('figure.uml').length, 2);
    assert.strictEqual(r.diagrams.length, 1);
  });

  test('a key named plantuml/puml/uml is a diagram even without @startuml', () => {
    const { r, doc } = render('plantuml: |\n  A -> B: hi\n  B --> A: ok\n');
    assert.strictEqual(r.diagrams.length, 1);
    assert.strictEqual(r.diagrams[0].source, '@startuml\nA -> B: hi\nB --> A: ok\n@enduml');
    assert.strictEqual(doc.querySelectorAll('figure.uml').length, 1);
    const one = render('uml: "A -> B"\n');
    assert.strictEqual(one.r.diagrams.length, 1, 'single-line value under a diagram key');
    assert.strictEqual(render('PlantUML: |\n  A -> B\n').r.diagrams.length, 1, 'key match is case-insensitive');
  });

  test('plantumlEnabled=false leaves the text alone', () => {
    const { r, doc } = render(`d: |\n  ${UML.replace(/\n/g, '\n  ')}\n`, { plantumlEnabled: false });
    assert.strictEqual(r.diagrams.length, 0);
    assert.strictEqual(doc.querySelectorAll('figure').length, 0);
    assert.match(doc.querySelector('pre.ml').textContent, /@startuml/);
  });

  test('other blocks (mindmap, gantt) are detected, not just uml', () => {
    const { r } = render('d: |\n  @startmindmap\n  * root\n  @endmindmap\n  @startgantt\n  [T] lasts 2 days\n  @endgantt\n');
    assert.strictEqual(r.diagrams.length, 2);
  });

  test('diagram count is capped', () => {
    const many = Array.from({ length: 130 }, (_, i) => `k${i}: |\n  @startuml\n  A -> B: ${i}\n  @enduml`).join('\n') + '\n';
    const { r, doc } = render(many);
    assert.strictEqual(r.diagrams.length, 100);
    assert.match(doc.body.textContent, /Diagram limit \(100\) reached/);
  });

  test('regular multi-line text is untouched', () => {
    const { r } = render('t: |\n  just\n  text\n');
    assert.strictEqual(r.diagrams.length, 0);
  });
});

suite('plantuml/markdown', () => {
  const md = (body, o = {}) => render(`description: |\n${body.split('\n').map((l) => '  ' + l).join('\n')}\n`, { markdown: 'all', ...o });
  test('```plantuml fences become diagrams; other fences stay code', () => {
    const { r, doc } = md('Text\n\n```plantuml\nA -> B\n```\n\n```js\nconst x = 1;\n```\n');
    assert.strictEqual(r.diagrams.length, 1);
    assert.strictEqual(r.diagrams[0].source, '@startuml\nA -> B\n@enduml');
    assert.strictEqual(doc.querySelectorAll('.md figure.uml').length, 1);
    assert.match(doc.querySelector('.md pre code').textContent, /const x = 1/);
  });
  test('puml / uml fence aliases work', () => {
    assert.strictEqual(md('```puml\nA -> B\n```').r.diagrams.length, 1);
    assert.strictEqual(md('```uml\nA -> B\n```').r.diagrams.length, 1);
  });
  test('bare @startuml blocks inside markdown prose become diagrams', () => {
    const { r, doc } = md(`Paragraph one.\n\n${UML}\n\nParagraph two with \`code\`.`);
    assert.strictEqual(r.diagrams.length, 1);
    assert.deepStrictEqual([...doc.querySelectorAll('.md p')].map((p) => p.textContent), ['Paragraph one.', 'Paragraph two with code.']);
    assert.ok(doc.querySelector('.md p code'), 'inline code is rendered');
  });
  test('a bare block directly after a paragraph line is still found', () => {
    assert.strictEqual(md(`intro line\n${UML}`).r.diagrams.length, 1);
  });
  test('an unclosed @startuml in markdown is plain text', () => {
    const { r, doc } = md('@startuml\nA -> B\nnever closed');
    assert.strictEqual(r.diagrams.length, 0);
    assert.match(doc.querySelector('.md').textContent, /@startuml/);
  });
  test('indented (code-block) @startuml is not hijacked', () => {
    assert.strictEqual(md('para\n\n        @startuml\n        A -> B\n        @enduml').r.diagrams.length, 0);
  });
});

suite('plantuml/results html', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>héllo</text></svg>';
  test('a finished diagram is an <img> data URI that round-trips the SVG', () => {
    const html = E.diagramInnerHtml({ svg }, UML);
    const dom = new JSDOM(`<figure>${html}</figure>`).window.document;
    const src = dom.querySelector('img.uml-img').getAttribute('src');
    assert.match(src, /^data:image\/svg\+xml;base64,/);
    assert.strictEqual(Buffer.from(src.split(',')[1], 'base64').toString('utf8'), svg);
    assert.match(dom.querySelector('.uml-src pre').textContent, /A -> B/);
    assert.ok(!dom.querySelector('svg'), 'the SVG is never inlined into the page');
  });
  test('errors and warnings are escaped', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const e = new JSDOM(`<figure>${E.diagramInnerHtml({ error: evil }, evil)}</figure>`).window.document;
    assert.strictEqual(e.querySelectorAll('img').length, 0);
    assert.strictEqual(e.querySelector('.uml-note.sev-error').textContent, evil);
    const w = new JSDOM(`<figure>${E.diagramInnerHtml({ svg, warning: evil }, UML)}</figure>`).window.document;
    assert.strictEqual(w.querySelectorAll('img').length, 1);
    assert.strictEqual(w.querySelector('.uml-note.sev-warning').textContent, evil);
  });
  test('non-SVG output is rejected rather than embedded', () => {
    const html = E.diagramInnerHtml({ svg: '<html><script>alert(1)</script></html>' }, UML);
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script'));
    assert.strictEqual(E.looksLikeSvg('<?xml version="1.0"?>\n<svg width="1"/>'), true);
    assert.strictEqual(E.looksLikeSvg('<div><svg/></div>'), false);
  });
  test('stderr is summarised', () => {
    assert.match(E.describePlantUmlStderr('ERROR\n2\nSyntax Error? (Assumed diagram type: sequence)\n'), /line 2: Syntax Error/);
    assert.strictEqual(E.describePlantUmlStderr(''), undefined);
    assert.strictEqual(E.describePlantUmlStderr('Some Java failure\nmore'), 'Some Java failure');
  });
  test('JVM log noise before the real message is skipped', () => {
    const noise = 'Nov 07, 2026 5:13:17 PM java.util.prefs.FileSystemPreferences$1 run\nWARNING: Couldn\'t create user preferences directory. User preferences are unusable.\n';
    assert.match(E.describePlantUmlStderr(noise + 'ERROR\n7\nSyntax Error?\n'), /line 7: Syntax Error/);
    assert.strictEqual(E.describePlantUmlStderr(noise), undefined, 'only noise → nothing to report');
    assert.strictEqual(E.describePlantUmlStderr('Picked up JAVA_TOOL_OPTIONS: -Xmx1g\nError: Unable to access jarfile x.jar'), 'Error: Unable to access jarfile x.jar');
    assert.strictEqual(E.describePlantUmlStderr('Sep 3, 2026, 4:05:06 PM sun.util.logging x\nINFO: hi\nreal problem'), 'real problem');
  });
});

suite('document view (requirements fixture)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'requirements.yaml'), 'utf8');
  const { r, doc } = render(src, { views: ['document'] });
  const dv = doc.querySelector('.docview');

  test('titles become headings, in document order', () => {
    const heads = [...dv.querySelectorAll('.dh:not(.key)')].map((h) => h.textContent);
    assert.deepStrictEqual(heads, ['req:user-login', 'Sign-in flow', 'Sign in with e-mail and password']);
  });

  test('metadata is a collapsed disclosure labelled by the node type', () => {
    const labels = [...dv.querySelectorAll('details.meta-details > summary')].map((s) => s.textContent);
    assert.deepStrictEqual(labels, ['Requirement metadata', 'Diagram metadata']);
    for (const d of dv.querySelectorAll('details.meta-details')) {
      assert.ok(!d.open, 'metadata starts collapsed');
    }
    assert.match(dv.querySelector('details.meta-details').textContent, /approved/);
  });

  test('the "type" key is folded into the disclosure label, not repeated', () => {
    assert.ok(![...dv.querySelectorAll('.fld .fk')].some((k) => k.textContent === 'type'));
  });

  test('body text is Markdown with inline code, and unlabelled', () => {
    const codes = [...dv.querySelectorAll('.blk.text.md code')].map((c) => c.textContent);
    assert.deepStrictEqual(codes, ['maxAttempts', 'AuthService.login']);
    assert.match(dv.querySelector('.blk.text.md').textContent, /shall be able to sign in/);
    assert.strictEqual(dv.querySelector('.blk.text.md .fk'), null);
  });

  test('the diagram is inline, directly after its metadata', () => {
    assert.strictEqual(r.diagrams.length, 1);
    assert.match(r.diagrams[0].source, /^@startuml\ntitle Sign-in/);
    const metaDiagram = [...dv.querySelectorAll('details.meta-details')][1];
    let next = metaDiagram.nextElementSibling;
    assert.ok(next && next.querySelector('figure.uml'), 'diagram follows "Diagram metadata"');
  });

  test('every block is addressable for scroll sync', () => {
    const lines = [...dv.querySelectorAll('[data-line]')].map((e) => Number(e.dataset.line));
    assert.ok(lines.length > 6);
    assert.ok(lines.every((n) => n >= 1));
    assert.ok(dv.querySelector('h2[data-ptr="/0/id"]'));
  });

  test('titles and keys are configurable', () => {
    const custom = render('- key: K1\n  body: hello `x`\n', { views: ['document'], documentTitleKeys: ['key'], documentTextKeys: ['body'] }).doc;
    assert.strictEqual(custom.querySelector('.dh').textContent, 'K1');
    assert.ok(custom.querySelector('.blk.text.md code'));
  });

  test('the file\'s leading comment is rendered once in the tree and once at most overall', () => {
    const t = render(src, { views: ['tree'] });
    const n = (t.r.content.match(/Requirements document with inline PlantUML/g) || []).length;
    assert.strictEqual(n, 1, `leading comment shown ${n} times`);
  });

  test('the tree outline names list items by their title', () => {
    const o = new JSDOM(`<nav>${render(src, { views: ['tree'] }).r.outline}</nav>`).window.document;
    assert.deepStrictEqual([...o.querySelectorAll('.ol-tree .name')].map((x) => x.textContent), ['[0] req:user-login', '[1] Sign-in flow']);
  });

  test('plain data still reads sensibly: fields, sub-sections, tables, lists', () => {
    const d = render('name: svc\nreplicas: 3\nlabels: [a, b]\nports:\n  - {n: http, p: 80}\n  - {n: tls, p: 443}\nspec:\n  image: x\n', { views: ['document'] }).doc;
    assert.strictEqual(d.querySelector('.dh').textContent, 'svc');
    assert.ok([...d.querySelectorAll('.fld')].some((f) => f.textContent.includes('replicas') && f.textContent.includes('3')));
    assert.strictEqual(d.querySelectorAll('.dl-list li').length, 2);
    assert.strictEqual(d.querySelectorAll('table.grid tbody tr').length, 2);
    // Every keyed list/map gets a heading; a bare bullet list would lose its meaning.
    assert.deepStrictEqual([...d.querySelectorAll('.dh.key')].map((h) => h.textContent), ['labels', 'ports', 'spec']);
  });

  test('masked keys are masked in the document view as well', () => {
    const d = render('id: x\npassword: hunter2\nnote: |\n  multi\n  line\n', { views: ['document'], maskKeys: ['pass'] });
    assert.ok(!d.r.content.includes('hunter2'));
    assert.ok(d.doc.querySelector('.masked'));
  });

  test('document view escapes hostile content', () => {
    const evil = '<script>alert(1)</script>';
    const d = render(`id: "${evil}"\nmetadata:\n  "${evil}": v\ntext: |\n  ${evil} [x](javascript:alert(1))\n`, { views: ['document'] }).doc;
    assert.strictEqual(d.querySelectorAll('script').length, 0);
    assert.ok(![...d.querySelectorAll('a')].some((a) => /^javascript:/i.test(a.getAttribute('href') || '')));
  });

  test('pure container keys (content:, items:) get no heading of their own', () => {
    const headKeys = [...dv.querySelectorAll('.dh.key')].map((h) => h.textContent);
    assert.ok(!headKeys.includes('content'), `unexpected "content" heading: ${headKeys}`);
    // …but the titled blocks inside it still nest under the section
    const h = (el) => Number(el.tagName[1]);
    const section = dv.querySelector('h2[data-ptr="/1/title"]');
    const nested = dv.querySelector('h3[data-ptr="/1/content/0/title"]');
    assert.ok(section && nested, 'section is h2, its diagram block is h3');
    assert.ok(h(nested) > h(section));
  });

  test('flatten keys are configurable', () => {
    const d = render('- id: a\n  stuff:\n    - {id: b}\n    - {id: c}\n', { views: ['document'], documentFlattenKeys: ['stuff'] }).doc;
    assert.ok(![...d.querySelectorAll('.dh.key')].some((x) => x.textContent === 'stuff'));
    const d2 = render('- id: a\n  stuff:\n    - {id: b}\n    - {id: c}\n', { views: ['document'], documentFlattenKeys: [] }).doc;
    assert.ok([...d2.querySelectorAll('.dh.key')].some((x) => x.textContent === 'stuff'));
  });

  test('prose reflows by default: hard-wrapped lines are not forced into <br>', () => {
    assert.strictEqual(dv.querySelectorAll('.blk.text.md br').length, 0);
    const br = render('text: |\n  one\n  two\n', { views: ['document'], breakOnSingleNewLine: true }).doc;
    assert.strictEqual(br.querySelectorAll('.blk.text.md br').length, 1, 'opt-in still works');
  });

  test('the outline lists titled blocks, nested, instead of [0] [1]', () => {
    const o = new JSDOM(`<nav>${r.outline}</nav>`).window.document;
    const top = [...o.querySelectorAll('.ol-document > ul > li > a .name')].map((n) => n.textContent);
    assert.deepStrictEqual(top, ['req:user-login', 'Sign-in flow']);
    const nested = [...o.querySelectorAll('.ol-document ul ul a .name')].map((n) => n.textContent);
    assert.deepStrictEqual(nested, ['Sign in with e-mail and password']);
    assert.ok(!/\[0\]/.test(o.querySelector('.ol-document').textContent));
  });

  test('without titled blocks the document outline falls back to the keys', () => {
    const o = new JSDOM(`<nav>${render('a: 1\nb: 2\n', { views: ['document'] }).r.outline}</nav>`).window.document;
    assert.deepStrictEqual([...o.querySelectorAll('.ol-document .name')].map((n) => n.textContent), ['a', 'b']);
  });

  test('outline variants follow the requested views', () => {
    const only = (views) => { const o = new JSDOM(`<nav>${render('a: 1\n', { views }).r.outline}</nav>`).window.document; return [!!o.querySelector('.ol-tree'), !!o.querySelector('.ol-document')]; };
    assert.deepStrictEqual(only(['tree']), [true, false]);
    assert.deepStrictEqual(only(['document']), [false, true]);
    assert.deepStrictEqual(only(['json']), [true, false]);
    assert.deepStrictEqual(only(undefined), [true, true]);
  });

  test('a single unnamed document has no "Document 1" title; real labels are kept', () => {
    assert.strictEqual(render('a: 1\n').doc.querySelector('.doc-title'), null);
    assert.strictEqual(render('kind: Pod\nname: p\n').doc.querySelector('.doc-title').textContent, 'Pod/p');
    assert.strictEqual(render('a: 1\n---\nb: 2\n').doc.querySelectorAll('.doc-title').length, 2, 'multi-doc keeps every title');
  });
});
