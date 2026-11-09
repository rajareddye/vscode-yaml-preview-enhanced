const assert = require('assert');
const E = require('../out/engine');

const validate = (yamlSrc, schema, popts) => {
  const parsed = E.parseYaml(yamlSrc, popts);
  E.validateParsed(parsed, E.compileSchema(schema), 'test.schema.json');
  return parsed;
};

suite('engine/schema', () => {
  const schema = {
    type: 'object',
    required: ['name', 'replicas'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      replicas: { type: 'integer', minimum: 1 },
      env: { enum: ['dev', 'prod'] },
      ports: { type: 'array', items: { type: 'integer' } },
    },
  };

  test('valid documents produce no issues', () => {
    const p = validate('name: web\nreplicas: 2\nenv: dev\n', schema);
    assert.strictEqual(p.docs[0].schemaIssues.length, 0);
    assert.deepStrictEqual(p.schema, { source: 'test.schema.json' });
  });

  test('violations are mapped onto the right source lines', () => {
    const p = validate('name: 5\nreplicas: 0\nenv: qa\nports:\n  - 80\n  - http\nextra: 1\n', schema);
    const issues = p.docs[0].schemaIssues;
    const at = (ptr) => issues.filter((i) => i.ptr === ptr);
    assert.strictEqual(at('/name')[0].line, 1);
    assert.match(at('/name')[0].message, /name must be string/);
    assert.strictEqual(at('/replicas')[0].line, 2);
    assert.match(at('/env')[0].message, /must be one of: "dev", "prod"/);
    assert.strictEqual(at('/ports/1')[0].line, 6);
    assert.strictEqual(at('/extra')[0].line, 7, 'additionalProperties points at the offending key');
    assert.match(at('/extra')[0].message, /unexpected property 'extra'/);
    // and they are attached to nodes so the tree can badge them
    const n = E.findNodeByPointer(p.docs[0].root, '/replicas', { exact: true });
    assert.strictEqual(n.issues.length, 1);
  });

  test('missing required properties are reported on the parent', () => {
    const p = validate('name: x\n', schema);
    const i = p.docs[0].schemaIssues[0];
    assert.match(i.message, /required property 'replicas'/);
    assert.strictEqual(i.ptr, '');
  });

  test('re-validating clears earlier results', () => {
    const p = validate('name: 5\nreplicas: 1\n', schema);
    assert.ok(p.docs[0].schemaIssues.length > 0);
    E.validateParsed(p, E.compileSchema({ type: 'object' }), 'loose');
    assert.strictEqual(p.docs[0].schemaIssues.length, 0);
    assert.strictEqual(E.findNodeByPointer(p.docs[0].root, '/name', { exact: true }).issues, undefined);
  });

  test('each document in a stream is validated independently', () => {
    const p = validate('name: a\nreplicas: 1\n---\nname: b\n', schema);
    assert.strictEqual(p.docs[0].schemaIssues.length, 0);
    assert.strictEqual(p.docs[1].schemaIssues.length, 1);
  });

  test('documents with syntax errors are not validated', () => {
    const p = validate('name: [unclosed\n', schema);
    assert.strictEqual(p.docs[0].schemaIssues.length, 0);
  });

  test('anchors/merge keys are resolved before validation', () => {
    const p = validate('base: &b {name: x, replicas: 1}\n', { type: 'object', properties: { base: schema } });
    assert.strictEqual(p.docs[0].schemaIssues.length, 0);
    const q = validate('d: &b {name: x, replicas: 1}\nc:\n  <<: *b\n', { type: 'object', properties: { c: schema } });
    assert.strictEqual(q.docs[0].schemaIssues.length, 0, 'merged keys count');
  });

  test('YAML 1.1 dates validate as date strings', () => {
    const s = { type: 'object', properties: { d: { type: 'string', format: 'date-time' } } };
    assert.strictEqual(validate('d: 2001-12-14T21:59:43Z\n', s, { version: '1.1' }).docs[0].schemaIssues.length, 0);
  });

  test('draft 2020-12, 2019-09 and unknown drafts compile', () => {
    for (const $schema of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-04/schema#']) {
      const p = validate('a: x\n', { $schema, type: 'object', properties: { a: { type: 'integer' } } });
      assert.strictEqual(p.docs[0].schemaIssues.length, 1, $schema);
    }
  });

  test('invalid schemas throw a readable error', () => {
    assert.throws(() => E.compileSchema({ type: 'nonsense' }), /./);
    assert.throws(() => E.compileSchema(null), /must be an object/);
  });

  test('parseSchemaText reads JSON and YAML', () => {
    assert.deepStrictEqual(E.parseSchemaText('{"type":"object"}'), { type: 'object' });
    assert.deepStrictEqual(E.parseSchemaText('type: object\nrequired: [a]\n'), { type: 'object', required: ['a'] });
  });

  test('schema issues surface in render output', () => {
    const p = validate('name: 5\nreplicas: 1\n', schema);
    const r = E.renderPreview(p, { ...E.DEFAULT_RENDER_OPTIONS, imagePreview: 'off' });
    assert.match(r.content, /1 schema issue/);
    assert.match(r.content, /issue-badge/);
    assert.strictEqual(r.meta.schemaIssueCount, 1);
  });

  test('markSchemaError is surfaced as a notice, not a crash', () => {
    const p = E.parseYaml('a: 1\n');
    E.markSchemaError(p, 'nope.json', 'ENOENT');
    const r = E.renderPreview(p, { ...E.DEFAULT_RENDER_OPTIONS, imagePreview: 'off' });
    assert.match(r.content, /could not be used: ENOENT/);
  });
});

suite('engine/glob', () => {
  const m = E.matchGlob;
  test('basic patterns', () => {
    assert.ok(m('*.yml', '/home/u/p/ci.yml'));
    assert.ok(!m('*.yml', '/home/u/p/ci.yaml'));
    assert.ok(m('.github/workflows/*.yml', '/home/u/p/.github/workflows/ci.yml'));
    assert.ok(!m('.github/workflows/*.yml', '/home/u/p/.github/workflows/sub/ci.yml'));
    assert.ok(m('**/charts/**/values.yaml', '/p/charts/a/b/values.yaml'));
    assert.ok(m('**/charts/**/values.yaml', 'charts/values.yaml'));
    assert.ok(m('k8s/*.{yml,yaml}', 'C:\\proj\\k8s\\a.yaml'.replace(/\\/g, '/')));
    assert.ok(m('a?.yml', 'x/ab.yml'));
  });
  test('absolute globs are anchored; others match suffixes only at a boundary', () => {
    assert.ok(m('/etc/app/*.yml', '/etc/app/x.yml'));
    assert.ok(!m('/etc/app/*.yml', '/home/etc/app/x.yml'));
    assert.ok(!m('ci.yml', '/p/notci.yml'));
  });
  test('regex metacharacters in globs are literal', () => {
    assert.ok(m('a+b(1).yml', 'a+b(1).yml'));
    assert.ok(!m('a.yml', 'abyml'));
  });
  test('backslash paths are normalised', () => {
    assert.ok(m('k8s/*.yml', 'C:\\proj\\k8s\\a.yml'));
  });
  test('matchSchemaMapping returns the first match', () => {
    const map = { 'a.json': ['docker-compose*.yml'], 'b.json': '**/*.yml' };
    assert.strictEqual(E.matchSchemaMapping(map, '/p/docker-compose.yml'), 'a.json');
    assert.strictEqual(E.matchSchemaMapping(map, '/p/other.yml'), 'b.json');
    assert.strictEqual(E.matchSchemaMapping(map, '/p/other.txt'), undefined);
  });
});

suite('engine/text', () => {
  test('linkify handles trailing punctuation and balanced parentheses', () => {
    const P = ['http://', 'https://'];
    const a = (s) => [...s.matchAll(/data-href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(a(E.linkify('see https://x.example/a.', P)), ['https://x.example/a']);
    assert.deepStrictEqual(a(E.linkify('(see https://x.example/a)', P)), ['https://x.example/a']);
    assert.deepStrictEqual(a(E.linkify('https://en.wikipedia.org/wiki/Foo_(bar)', P)), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
    assert.deepStrictEqual(a(E.linkify('a, https://x.example/1, https://y.example/2!', P)), ['https://x.example/1', 'https://y.example/2']);
    assert.deepStrictEqual(a(E.linkify('https:// alone', P)), []);
    assert.strictEqual(E.linkify('no links <b>', P), 'no links &lt;b&gt;');
    assert.strictEqual(E.linkify('http://x.example', []), 'http://x.example');
  });
  test('protocol whitelist parsing and checks', () => {
    const p = E.parseProtocols('http://, HTTPS://,mailto: ');
    assert.deepStrictEqual(p, ['http://', 'https://', 'mailto:']);
    assert.ok(E.isAllowedUrl('https://x', p) && E.isAllowedUrl('MAILTO:a@b', p));
    assert.ok(!E.isAllowedUrl('javascript:alert(1)', p));
    assert.ok(!E.isAllowedUrl('file:///etc/passwd', p));
    assert.ok(!E.isAllowedUrl('relative/path', p));
    assert.ok(!E.isAllowedUrl('  javascript:x', p));
  });
  test('classifyImageRef', () => {
    assert.deepStrictEqual(E.classifyImageRef('img/a.PNG'), { kind: 'local', path: 'img/a.PNG' });
    assert.deepStrictEqual(E.classifyImageRef('https://x/a.svg?v=1'), { kind: 'remote', url: 'https://x/a.svg?v=1' });
    for (const bad of ['http://x/a.png', 'data:image/png;base64,AA.png', '/etc/a.png', '//x/a.png', 'file:///a.png', 'a b.png', 'notimage.txt', 'javascript:a.png']) {
      assert.strictEqual(E.classifyImageRef(bad), undefined, bad);
    }
  });
});

suite('engine/export', () => {
  const O = { sortKeys: 'none', maskKeys: [] };
  const src = 'title: Demo\nbase: &b {a: 1}\nchild:\n  <<: *b\n  b: 2\nitems:\n  - {id: 1, name: x|y}\n  - {id: 2, name: z}\ntags: [a, b]\nnotes: |\n  line1\n  line2\npassword: hunter2\n';

  test('JSON export resolves anchors, honours masking/sorting and unwraps single docs', () => {
    const j = JSON.parse(E.exportJson(E.parseYaml(src), { sortKeys: 'asc', maskKeys: ['pass'] }));
    assert.deepStrictEqual(j.child, { a: 1, b: 2 });
    assert.strictEqual(j.password, '••••••');
    assert.deepStrictEqual(Object.keys(j), Object.keys(j).slice().sort());
    const multi = JSON.parse(E.exportJson(E.parseYaml('a: 1\n---\nb: 2\n'), O));
    assert.deepStrictEqual(multi, [{ a: 1 }, { b: 2 }]);
  });

  test('resolved YAML joins documents with ---', () => {
    const y = E.exportResolvedYaml(E.parseYaml('a: &x 1\nb: *x\n---\nc: 3\n'), O);
    assert.strictEqual(y, 'a: 1\nb: 1\n---\nc: 3\n');
  });

  test('exports throw a clear error when nothing is resolvable', () => {
    assert.throws(() => E.exportJson(E.parseYaml('a: *nope\n'), O), /alias/i);
    assert.throws(() => E.exportResolvedYaml(E.parseYaml(''), O), /nothing to export/i);
  });

  test('Markdown export: headings, bullets, tables, fences', () => {
    const md = E.exportMarkdown(E.parseYaml(src), { ...O, title: 'demo.yaml', maskKeys: ['pass'] });
    assert.match(md, /^# demo\.yaml\n/);
    assert.match(md, /- \*\*title\*\*: Demo/);
    assert.match(md, /## child\n\n- \*\*a\*\*: 1\n- \*\*b\*\*: 2/);
    assert.match(md, /\| id \| name \|\n\| --- \| --- \|\n\| 1 \| x\\\|y \|\n\| 2 \| z \|/);
    assert.match(md, /## tags\n\n- a\n- b/);
    assert.match(md, /## notes\n\n```\nline1\nline2\n```/);
    assert.match(md, /\*\*password\*\*: ••••••/);
    assert.ok(!md.includes('hunter2'));
  });

  test('Markdown export labels multi-document streams', () => {
    const md = E.exportMarkdown(E.parseYaml('kind: A\nname: one\n---\nkind: B\nname: two\n'), { ...O, title: 't' });
    assert.match(md, /## A\/one/);
    assert.match(md, /## B\/two/);
  });

  test('Markdown fences cannot be broken out of by content', () => {
    const md = E.exportMarkdown(E.parseYaml('x: |\n  ```\n  evil\n  ```\n'), { ...O, title: 't' });
    assert.match(md, /````\n```\nevil\n```\n````/);
  });
});
