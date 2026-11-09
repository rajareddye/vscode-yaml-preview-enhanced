const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createVscode, withStub } = require('./vscode-stub');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const nls = require('../package.nls.json');
const P = 'yaml-preview-enhanced';

function loadHost() {
  const { vscode, helpers } = createVscode();
  const bundle = require.resolve('../out/host/index.js');
  delete require.cache[bundle];
  const host = withStub(vscode, () => require(bundle));
  return { vscode, helpers, host };
}

suite('manifest consistency', () => {
  const { host } = loadHost();

  test('settings: the code’s defaults equal the manifest’s defaults, and the key sets match', () => {
    const props = pkg.contributes.configuration.properties;
    const manifest = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.slice(P.length + 1), v.default]));
    assert.deepStrictEqual(Object.keys(host.DEFAULTS).sort(), Object.keys(manifest).sort(), 'every setting in the manifest is read by the code and vice versa');
    for (const [k, v] of Object.entries(manifest)) {
      assert.deepStrictEqual(host.DEFAULTS[k], v, `default of "${k}" differs between package.json and config.ts`);
    }
  });

  test('settings: enum defaults are members of their enum; types match defaults', () => {
    for (const [k, v] of Object.entries(pkg.contributes.configuration.properties)) {
      if (v.enum) assert.ok(v.enum.includes(v.default), `${k}: default not in enum`);
      const t = Array.isArray(v.default) ? 'array' : typeof v.default;
      assert.strictEqual(v.type, t, `${k}: declared type ${v.type} but default is ${t}`);
      assert.ok(v.markdownDescription, `${k}: missing description`);
    }
  });

  test('every %nls% key used in package.json exists in package.nls.json (and none is unused)', () => {
    const used = new Set();
    JSON.stringify(pkg, (k, v) => { if (typeof v === 'string') for (const m of v.matchAll(/^%(.+)%$/g)) used.add(m[1]); return v; });
    for (const k of used) assert.ok(k in nls, `missing nls key: ${k}`);
    for (const k of Object.keys(nls)) assert.ok(used.has(k), `unused nls key: ${k}`);
  });

  test('commands: palette/menu/keybinding entries refer to declared commands', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    const refs = [
      ...pkg.contributes.keybindings.map((k) => k.command),
      ...Object.values(pkg.contributes.menus).flat().map((m) => m.command),
    ];
    for (const r of refs) assert.ok(declared.has(r), `undeclared command referenced: ${r}`);
    assert.strictEqual(declared.size, pkg.contributes.commands.length, 'duplicate command ids');
  });

  test('untrusted-workspace restrictions cover everything that can run code or spawn processes', () => {
    const restricted = new Set(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations);
    for (const k of ['chromePath', 'chromeArgs', 'configPath', 'enableScriptExecution', 'plantumlJarPath', 'javaPath', 'plantumlArgs', 'plantumlSecurityProfile', 'allowRemoteSchemas']) {
      assert.ok(restricted.has(`${P}.${k}`), `${k} must be restricted in untrusted workspaces`);
      assert.strictEqual(pkg.contributes.configuration.properties[`${P}.${k}`].scope, 'machine', `${k} should be machine-scoped`);
    }
    for (const k of restricted) assert.ok(k in pkg.contributes.configuration.properties, `restricted unknown setting ${k}`);
  });

  test('the shipped entry points and assets exist after a build', () => {
    for (const f of [pkg.main, pkg.browser, 'out/webview/preview.js', pkg.icon]) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `missing ${f}`);
    }
  });

  test('keybinding chords are unique', () => {
    const keys = pkg.contributes.keybindings.map((k) => k.key);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

suite('activation (real entry points)', () => {
  function activate(entry) {
    const { vscode, helpers } = createVscode();
    const bundle = require.resolve(path.join(ROOT, entry));
    delete require.cache[bundle];
    const mod = withStub(vscode, () => require(bundle));
    const ctx = helpers.context(ROOT);
    mod.activate(ctx);
    return { helpers, ctx, mod };
  }

  for (const [name, entry] of [['desktop', pkg.main], ['web', pkg.browser]]) {
    test(`${name}: registers exactly the declared commands (plus internal ones)`, () => {
      const { helpers } = activate(entry);
      const declared = new Set(pkg.contributes.commands.map((c) => c.command));
      const registered = new Set(helpers.commandsMap.keys());
      const { INTERNAL_COMMANDS } = loadHost().host;
      for (const c of declared) assert.ok(registered.has(c), `${name}: command not registered: ${c}`);
      for (const c of registered) assert.ok(declared.has(c) || INTERNAL_COMMANDS.includes(c.slice(P.length + 1)), `${name}: registered but not declared: ${c}`);
    });

    test(`${name}: registers the custom editor and disposes cleanly`, () => {
      const { helpers, ctx } = activate(entry);
      assert.ok(helpers.customEditors[P], 'custom editor provider registered');
      assert.doesNotThrow(() => ctx.subscriptions.forEach((s) => s.dispose && s.dispose()));
    });
  }

  test('the web bundle never loads Node-only modules', () => {
    const src = fs.readFileSync(path.join(ROOT, pkg.browser), 'utf8');
    assert.ok(!/require\("(fs|child_process|os|path|module)"\)/.test(src));
    assert.ok(!/puppeteer/.test(src));
  });
});

suite('editor associations (Previews Only)', () => {
  const { host } = loadHost();
  const v = 'yaml-preview-enhanced';
  test('Previews Only maps each extension; other modes remove only our own entries', () => {
    const on = host.computeEditorAssociations(undefined, 'Previews Only', v, ['.yaml', '.yml']);
    assert.deepStrictEqual(on, { '*.yaml': v, '*.yml': v });
    const off = host.computeEditorAssociations({ ...on, 'docs/*.yaml': v, '*.md': 'other' }, 'Single Preview', v, ['.yaml', '.yml']);
    assert.deepStrictEqual(off, { 'docs/*.yaml': v, '*.md': 'other' }, 'a user-made mapping survives');
  });
  test('an existing mapping to another editor is not overridden; no-ops return undefined', () => {
    assert.deepStrictEqual(host.computeEditorAssociations({ '*.yaml': 'other' }, 'Previews Only', v, ['.yaml', '.yml']), { '*.yaml': 'other', '*.yml': v });
    assert.strictEqual(host.computeEditorAssociations({ '*.yaml': v, '*.yml': v }, 'Previews Only', v, ['.yaml', '.yml']), undefined);
    assert.strictEqual(host.computeEditorAssociations({}, 'Single Preview', v, ['.yaml']), undefined);
    assert.strictEqual(host.computeEditorAssociations(['legacy'], 'Previews Only', v, ['.yaml']), undefined, 'legacy array format untouched');
  });
  test('extensions without a leading dot are accepted', () => {
    assert.deepStrictEqual(host.computeEditorAssociations({}, 'Previews Only', v, ['yaml']), { '*.yaml': v });
  });
});
