const assert = require('assert');
const E = require('../out/engine');

const find = (node, ptr) =>
  E.findNodeByPointer(node, ptr, { exact: true });

suite('engine/parse', () => {
  test('builds a tree with pointers, types and source lines', () => {
    const r = E.parseYaml('name: app\nport: 8080\nratio: 1.5\non: true\nnone: ~\nlist:\n  - a\n  - b: 2\n');
    assert.strictEqual(r.docs.length, 1);
    const d = r.docs[0];
    assert.strictEqual(d.root.type, 'map');
    assert.deepStrictEqual(d.root.children.map((c) => c.key.text), ['name', 'port', 'ratio', 'on', 'none', 'list']);
    const kinds = d.root.children.map((c) => c.scalar && c.scalar.kind);
    assert.deepStrictEqual(kinds, ['string', 'int', 'float', 'bool', 'null', undefined]);
    assert.strictEqual(find(d.root, '/port').line, 2);
    assert.strictEqual(find(d.root, '/list/1/b').scalar.text, '2');
    assert.strictEqual(find(d.root, '/list/1/b').line, 8);
    assert.strictEqual(find(d.root, '/list/0').index, 0);
  });

  test('preserves the written form of numbers and booleans', () => {
    const d = E.parseYaml('a: 0x1F\nb: 1_000\nc: 1e3\n', { version: '1.1' }).docs[0];
    assert.strictEqual(find(d.root, '/a').scalar.text, '0x1F');
    assert.strictEqual(find(d.root, '/c').scalar.text, '1e3');
    const y = E.parseYaml('a: yes\n', { version: '1.1' }).docs[0];
    assert.strictEqual(find(y.root, '/a').scalar.kind, 'bool');
    assert.strictEqual(find(y.root, '/a').scalar.text, 'yes');
    const y12 = E.parseYaml('a: yes\n').docs[0];
    assert.strictEqual(find(y12.root, '/a').scalar.kind, 'string');
  });

  test('YAML 1.1 timestamps become timestamp scalars; 1.2 keeps strings', () => {
    assert.strictEqual(find(E.parseYaml('d: 2001-12-14\n', { version: '1.1' }).docs[0].root, '/d').scalar.kind, 'timestamp');
    assert.strictEqual(find(E.parseYaml('d: 2001-12-14\n').docs[0].root, '/d').scalar.kind, 'string');
  });

  test('anchors, aliases and merge keys are linked', () => {
    const d = E.parseYaml('base: &base\n  a: 1\nchild:\n  <<: *base\n  c: 3\nother: *base\n').docs[0];
    assert.strictEqual(d.anchors.length, 1);
    assert.strictEqual(d.anchors[0].name, 'base');
    assert.strictEqual(d.anchors[0].usages, 2);
    const merge = find(d.root, '/child/<<');
    assert.ok(merge.key.isMerge);
    assert.strictEqual(merge.type, 'alias');
    assert.strictEqual(merge.alias.targetNid, find(d.root, '/base').nid);
    assert.deepStrictEqual(d.json.child, { a: 1, c: 3 });
  });

  test('an alias with no preceding anchor is reported (yaml itself stays silent)', () => {
    const r = E.parseYaml('a: *nope\n');
    const d = r.docs[0];
    assert.strictEqual(d.errors.length, 1);
    assert.strictEqual(d.errors[0].code, 'UNRESOLVED_ALIAS');
    assert.strictEqual(d.errors[0].line, 1);
    assert.ok(find(d.root, '/a').issues.length === 1);
    assert.ok(d.resolveError, 'resolved view must be unavailable');
    assert.strictEqual(r.errorCount, 1);
  });

  test('alias bombs do not take down the tree view', () => {
    let src = 'a: &a [x,x,x,x,x,x,x,x,x]\n';
    let prev = 'a';
    for (const n of 'bcdefghi') {
      src += `${n}: &${n} [${Array(9).fill('*' + prev).join(',')}]\n`;
      prev = n;
    }
    const d = E.parseYaml(src, { maxAliasCount: 100 }).docs[0];
    assert.ok(d.root, 'tree still built');
    assert.match(d.resolveError, /alias/i);
    assert.strictEqual(d.json, undefined);
  });

  test('custom tags parse silently by default and warn when asked', () => {
    const src = 'a: !Ref Thing\nb: !Join [x, y]\nc: !!str 123\n';
    const quiet = E.parseYaml(src).docs[0];
    assert.strictEqual(quiet.warnings.length, 0);
    assert.strictEqual(find(quiet.root, '/a').tag, '!Ref');
    assert.strictEqual(find(quiet.root, '/b').tag, '!Join');
    assert.strictEqual(find(quiet.root, '/b').type, 'seq');
    assert.strictEqual(find(quiet.root, '/c').tag, '!!str');
    assert.strictEqual(find(quiet.root, '/c').scalar.kind, 'string');
    const loud = E.parseYaml(src, { ignoreUnknownTagWarnings: false }).docs[0];
    assert.strictEqual(loud.warnings.length, 2);
  });

  test('multi-document streams, including an empty document', () => {
    const r = E.parseYaml('---\na: 1\n---\n---\nkind: Service\nmetadata:\n  name: web\n');
    assert.strictEqual(r.docs.length, 3);
    // An empty document is a null scalar with no source text.
    assert.strictEqual(r.docs[1].root.type, 'scalar');
    assert.strictEqual(r.docs[1].root.scalar.kind, 'null');
    assert.strictEqual(r.docs[1].root.scalar.text, '');
    assert.strictEqual(r.docs[2].label, 'Service/web');
    assert.strictEqual(r.docs[0].label, 'Document 1');
    assert.ok(r.docs[2].startLine > r.docs[0].startLine);
  });

  test('empty and comment-only input yield zero documents', () => {
    assert.strictEqual(E.parseYaml('').docs.length, 0);
    assert.strictEqual(E.parseYaml('# nothing here\n').docs.length, 0);
  });

  test('syntax errors carry line/column', () => {
    const d = E.parseYaml('a: 1\nb: [1, 2\nc: 3\n').docs[0];
    assert.ok(d.errors.length > 0);
    assert.ok(d.errors[0].line >= 2);
    assert.ok(d.errors[0].col >= 1);
    assert.strictEqual(d.errors[0].severity, 'error');
  });

  test('duplicate keys are errors only when uniqueKeys is on', () => {
    assert.strictEqual(E.parseYaml('a: 1\na: 2\n').docs[0].errors[0].code, 'DUPLICATE_KEY');
    assert.strictEqual(E.parseYaml('a: 1\na: 2\n', { uniqueKeys: false }).docs[0].errors.length, 0);
  });

  test('comments are attached above and after rows', () => {
    const d = E.parseYaml('# top\n\nfoo: 1 # trailing\n# before bar\nbar:\n  # lead of baz\n  baz: 2\n').docs[0];
    assert.match(d.commentBefore || '', /top/);
    assert.strictEqual(find(d.root, '/foo').comment, 'trailing');
    assert.strictEqual(find(d.root, '/bar').commentBefore, 'before bar');
    assert.strictEqual(find(d.root, '/bar/baz').commentBefore, 'lead of baz');
  });

  test('a leading comment is attached once, not to every first child', () => {
    const d = E.parseYaml('# Header comment\n- id: a\n  type: x\n- id: b\n').docs[0];
    const holders = [];
    (function walk(n) { if (n.commentBefore && n.commentBefore.includes('Header comment')) holders.push(n.ptr || '(root)'); (n.children || []).forEach(walk); })(d.root);
    const docLevel = (d.commentBefore || '').includes('Header comment') ? 1 : 0;
    assert.strictEqual(holders.length + docLevel, 1, `comment held by: ${holders} docLevel=${docLevel}`);
    // sibling comments are untouched
    const e = E.parseYaml('# one\na: 1\n# two\nb: 2\n').docs[0];
    assert.strictEqual(find(e.root, '/b').commentBefore, 'two');
  });

  test('scalar styles and multi-line detection', () => {
    const d = E.parseYaml("a: 'single'\nb: \"dbl\"\nc: |\n  l1\n  l2\nd: >\n  f1\n  f2\ne: plain\n").docs[0];
    const style = (p) => find(d.root, p).scalar.style;
    assert.deepStrictEqual(['/a', '/b', '/c', '/d', '/e'].map(style), ['single', 'double', 'literal', 'folded', 'plain']);
    assert.strictEqual(find(d.root, '/c').scalar.multiline, true);
    assert.strictEqual(find(d.root, '/e').scalar.multiline, false);
  });

  test('complex and non-string keys', () => {
    const d = E.parseYaml('? [a, b]\n: x\n1: one\ntrue: yes\n').docs[0];
    assert.strictEqual(d.root.children[0].key.kind, 'complex');
    assert.strictEqual(d.root.children[0].key.text, '["a","b"]');
    assert.strictEqual(d.root.children[1].key.text, '1');
    assert.strictEqual(d.root.children[1].key.kind, 'int');
    assert.strictEqual(d.root.children[2].key.text, 'true');
  });

  test('root scalars and sequences', () => {
    assert.strictEqual(E.parseYaml('just text\n').docs[0].root.type, 'scalar');
    const s = E.parseYaml('- a\n- b: 1\n- - n\n').docs[0].root;
    assert.strictEqual(s.type, 'seq');
    assert.strictEqual(s.children.length, 3);
    assert.strictEqual(s.children[2].type, 'seq');
  });

  test('CRLF line endings keep lines correct', () => {
    const d = E.parseYaml('a: 1\r\nb: 2\r\nc: 3\r\n').docs[0];
    assert.strictEqual(find(d.root, '/c').line, 3);
  });

  test('block scalar end line excludes trailing newlines', () => {
    const d = E.parseYaml('a: |\n  one\n  two\n\nb: 1\n').docs[0];
    const a = find(d.root, '/a');
    assert.strictEqual(a.line, 1);
    assert.strictEqual(a.endLine, 3);
    assert.strictEqual(find(d.root, '/b').line, 5);
  });

  test('schema modeline is detected only in the leading comments', () => {
    assert.strictEqual(E.detectSchemaRef('# yaml-language-server: $schema=./s.json\na: 1\n'), './s.json');
    assert.strictEqual(E.detectSchemaRef('# hi\n\n# yaml-language-server: $schema=https://x/y.json\n'), 'https://x/y.json');
    assert.strictEqual(E.detectSchemaRef('a: 1\n# yaml-language-server: $schema=./s.json\n'), undefined);
  });

  test('very deep nesting is collapsed instead of overflowing the stack', () => {
    const src = '['.repeat(400) + ']'.repeat(400);
    const d = E.parseYaml(src).docs[0];
    let n = d.root, depth = 0;
    while (n.children && n.children[0]) { n = n.children[0]; depth++; }
    assert.ok(depth <= 202, `depth ${depth}`);
  });
});

suite('engine/pointer', () => {
  test('round-trips escaped segments', () => {
    const p = E.pointerFromSegments(['a/b', 'c~d', 0]);
    assert.strictEqual(p, '/a~1b/c~0d/0');
    assert.deepStrictEqual(E.parsePointer(p), ['a/b', 'c~d', '0']);
  });
  test('formats dot and JSONPath', () => {
    assert.strictEqual(E.toDotPath('/spec/containers/0/name'), 'spec.containers[0].name');
    assert.strictEqual(E.toDotPath('/a.b/c'), '["a.b"].c'.replace(/^\./, ''));
    assert.strictEqual(E.toJsonPath('/spec/containers/0/name'), '$.spec.containers[0].name');
    assert.strictEqual(E.toJsonPath('/my-key'), '$["my-key"]');
    assert.strictEqual(E.toDotPath(''), '$');
  });
  test('getByPointer', () => {
    assert.strictEqual(E.getByPointer({ a: [{ b: 5 }] }, '/a/0/b'), 5);
    assert.strictEqual(E.getByPointer({ a: 1 }, '/x/y'), undefined);
  });
});
