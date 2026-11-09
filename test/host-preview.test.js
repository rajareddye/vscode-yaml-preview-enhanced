const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, tmpDir, write, dom, VT, REQ, Uri } = require('./host-helpers');

const SIMPLE = 'name: web\nreplicas: 2\nitems:\n  - {id: 1, n: a}\n  - {id: 2, n: b}\n';
const html = (p) => p.webview.html;

suite('host: opening previews', function () {
  this.timeout(60000);
  let dir;
  suiteSetup(() => { dir = tmpDir(); });

  test('renders the document into a webview with a strict, nonce-based CSP', async () => {
    const x = boot({ config: { defaultView: 'document' } });
    x.h.openDoc(write(dir, 'req.yaml', REQ));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    const d = dom(html(panel));
    assert.strictEqual(panel.title, 'Preview req.yaml');
    assert.strictEqual(panel.viewColumn, -2, 'opens beside the editor');
    assert.ok(panel.options.enableScripts && panel.options.retainContextWhenHidden);
    const csp = d.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
    const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)[1];
    assert.match(csp, /default-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
    assert.ok(!/https:/.test(csp), 'no remote images unless imagePreview=all');
    assert.match(csp, /img-src vscode-webview-resource: data:;/);
    for (const el of d.querySelectorAll('script[src], style')) assert.strictEqual(el.getAttribute('nonce'), nonce, `${el.tagName} must carry the nonce`);
    assert.match(d.querySelector('script[src]').src, /out\/webview\/preview\.js$/);
    assert.strictEqual(d.body.dataset.view, 'document');
    assert.match(d.querySelector('.docview').textContent, /req:user-login/);
    assert.ok(d.querySelector('figure.uml.pending'), 'diagram starts as a placeholder');
    x.dispose();
  });

  test('every CSP nonce is unique per page build', async () => {
    const x = boot();
    x.h.openDoc(write(dir, 'n.yaml', SIMPLE));
    await x.h.run('openPreviewToTheSide');
    await x.h.until(() => html(x.h.panels[0]));
    const a = /nonce-([A-Za-z0-9]+)/.exec(html(x.h.panels[0]))[1];
    const before = html(x.h.panels[0]);
    x.h.setConfig('previewTheme', 'one-dark'); // forces a full rebuild
    await x.h.until(() => html(x.h.panels[0]) !== before);
    const b = /nonce-([A-Za-z0-9]+)/.exec(html(x.h.panels[0]))[1];
    assert.notStrictEqual(a, b);
    assert.strictEqual(a.length, 32);
    x.dispose();
  });

  test('PlantUML diagrams are rendered by the real jar and streamed into the page', async () => {
    const x = boot({ config: { defaultView: 'document' } });
    x.h.openDoc(write(dir, 'req.yaml', REQ));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    const msg = await x.h.until(() => panel.messages('diagram')[0]);
    const placeholder = dom(html(panel)).querySelector('figure.uml').dataset.uml;
    assert.strictEqual(msg.hash, placeholder, 'result is keyed to the placeholder in the page');
    assert.match(msg.html, /<img class="uml-img"[^>]*src="data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(/base64,([^"]+)"/.exec(msg.html)[1], 'base64').toString();
    assert.match(svg, /data-diagram-type="SEQUENCE"/);
    assert.ok(svg.includes('Auth Service') && svg.includes('session token'));
    x.dispose();
  });

  test('a page reload ("ready") re-sends diagrams the new page does not have', async () => {
    const x = boot({ config: { defaultView: 'document' } });
    x.h.openDoc(write(dir, 'req.yaml', REQ));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => panel.messages('diagram').length === 1);
    panel.receive({ command: 'ready' });
    await x.h.until(() => panel.messages('diagram').length === 2);
    x.dispose();
  });

  test('typing sends cheap updates and never resends diagrams the page already holds', async () => {
    const x = boot({ config: { defaultView: 'document' } });
    const { uri } = x.h.openDoc(write(dir, 'req.yaml', REQ));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => panel.messages('diagram').length === 1);
    const pageBefore = html(panel);
    x.h.edit(uri, REQ.replace('status: approved', 'status: rejected'));
    const upd = await x.h.until(() => panel.messages('update')[0]);
    assert.match(upd.content, /rejected|req:user/);
    assert.strictEqual(html(panel), pageBefore, 'the page itself is not rebuilt');
    assert.strictEqual(upd.view, 'document');
    assert.ok(upd.toggles && upd.config && upd.status.includes('nodes'));
    await x.h.sleep(150);
    assert.strictEqual(panel.messages('diagram').length, 1, 'unchanged diagram is not re-rendered or re-sent');
    // …but editing the diagram itself sends exactly one new result
    // keep the 8-space indentation of the block scalar, or the YAML breaks
    x.h.edit(uri, REQ.replace('        autonumber', '        autonumber\n        skinparam shadowing false'));
    await x.h.until(() => panel.messages('diagram').length === 2);
    x.dispose();
  });

  test('a burst of keystrokes collapses into one render (debounce)', async () => {
    const x = boot({ config: { liveUpdateDebounceMs: 80 } });
    const { uri } = x.h.openDoc(write(dir, 'b.yaml', SIMPLE));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    for (let i = 0; i < 6; i++) { x.h.edit(uri, SIMPLE + `k${i}: ${i}\n`); await x.h.sleep(5); }
    await x.h.until(() => panel.messages('update').length >= 1);
    await x.h.sleep(250);
    assert.strictEqual(panel.messages('update').length, 1);
    assert.match(panel.messages('update')[0].content, /k5/);
    x.dispose();
  });

  test('with liveUpdate off the preview refreshes on save, not on typing', async () => {
    const x = boot({ config: { liveUpdate: false } });
    const { uri } = x.h.openDoc(write(dir, 'l.yaml', SIMPLE));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    x.h.edit(uri, SIMPLE + 'extra: 1\n');
    await x.h.sleep(150);
    assert.strictEqual(panel.messages('update').length, 0);
    x.h.save(uri);
    const upd = await x.h.until(() => panel.messages('update')[0]);
    assert.match(upd.content, /extra/);
    x.dispose();
  });

  test('a render that fails shows the error instead of a blank panel', async () => {
    const x = boot({ platform: { customization: { loadCss: async () => '', loadHead: async () => '', loadConfigOverrides: async () => ({}), loadParserHooks: async () => { throw new Error('hook exploded <b>'); }, openFile: async () => {} } } });
    x.h.openDoc(write(dir, 'e.yaml', SIMPLE));
    await x.h.run('openPreviewToTheSide');
    await x.h.until(() => html(x.h.panels[0]));
    assert.match(html(x.h.panels[0]), /Could not render e\.yaml/);
    assert.ok(html(x.h.panels[0]).includes('hook exploded &#60;b&#62;'), 'message is escaped');
    x.dispose();
  });

  test('the panel is disposed cleanly and later events do not throw', async () => {
    const x = boot();
    const { uri } = x.h.openDoc(write(dir, 'd.yaml', SIMPLE));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    panel.dispose();
    assert.doesNotThrow(() => { x.h.edit(uri, SIMPLE + 'z: 1\n'); x.h.fireSelection(uri, 1); x.h.fireVisible(uri, 1); });
    await x.h.sleep(60);
    assert.strictEqual(panel.messages('update').length, 0);
    x.dispose();
  });
});

suite('host: preview modes', function () {
  this.timeout(60000);
  let dir, A, B;
  suiteSetup(() => { dir = tmpDir(); A = write(dir, 'a.yaml', 'which: A\n'); B = write(dir, 'b.yaml', 'which: B\n'); });

  test('Single Preview follows the active editor; a locked preview does not', async () => {
    const x = boot();
    const a = x.h.openDoc(A);
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    assert.match(html(panel), /which/);
    const b = x.h.openDoc(B);
    x.h.activate(b.uri);
    await x.h.until(() => panel.title === 'Preview b.yaml');
    assert.strictEqual(x.h.panels.length, 1, 'still one shared panel');
    await x.h.until(() => /\bB\b/.test(html(panel)));

    await x.h.run('togglePreviewLock');
    assert.strictEqual(panel.title, '🔒 Preview b.yaml');
    x.h.activate(a.uri);
    await x.h.sleep(100);
    assert.strictEqual(panel.title, '🔒 Preview b.yaml', 'locked: does not follow');
    await x.h.run('togglePreviewLock');
    assert.strictEqual(panel.title, 'Preview b.yaml');
    x.h.activate(a.uri);
    await x.h.until(() => panel.title === 'Preview a.yaml');
    x.dispose();
  });

  test('Multiple Previews: one panel per file, reused when reopened', async () => {
    const x = boot({ config: { previewMode: 'Multiple Previews' } });
    x.h.openDoc(A);
    await x.h.run('openPreviewToTheSide');
    x.h.openDoc(B);
    await x.h.run('openPreviewToTheSide');
    assert.strictEqual(x.h.panels.length, 2);
    await x.h.until(() => x.h.panels.every((p) => html(p)));
    x.h.openDoc(A);
    await x.h.run('openPreviewToTheSide');
    assert.strictEqual(x.h.panels.length, 2, 'no duplicate for the same file');
    assert.ok(x.h.panels[0].revealedWith !== undefined, 'existing panel was revealed');
    assert.deepStrictEqual(x.h.panels.map((p) => p.title), ['Preview a.yaml', 'Preview b.yaml']);
    x.dispose();
  });

  test('"Open Locked Preview" makes an independent panel even in Single mode', async () => {
    const x = boot();
    x.h.openDoc(A);
    await x.h.run('openPreviewToTheSide');
    await x.h.run('openLockedPreviewToTheSide');
    assert.strictEqual(x.h.panels.length, 2);
    assert.strictEqual(x.h.panels[1].title, '🔒 Preview a.yaml');
    x.dispose();
  });

  test('Previews Only: opens through the custom editor and adopts its panel', async () => {
    const x = boot({ config: { previewMode: 'Previews Only' } });
    const { uri, doc } = x.h.openDoc(A);
    await x.h.run('openPreview');
    assert.strictEqual(x.h.state.openedWith.length, 1);
    assert.strictEqual(x.h.state.openedWith[0][1], VT);
    // what VS Code does next:
    const panel = x.vscode.window.createWebviewPanel(VT, 'x', 1, {});
    await x.h.customEditors[VT].resolveCustomTextEditor(doc, panel);
    assert.ok(panel.webview.options.enableScripts);
    await x.h.until(() => html(panel));
    assert.match(html(panel), /which/);
    assert.strictEqual(panel.title, 'x', 'the custom editor title is left to VS Code');
    x.dispose();
  });

  test('switching the mode updates workbench.editorAssociations (and only our entries)', async () => {
    const x = boot({ config: { previewMode: 'Previews Only' } });
    await x.h.sleep(20);
    assert.deepStrictEqual(x.h.state.editorAssociations, { '*.yaml': VT, '*.yml': VT });
    x.h.state.editorAssociations['*.json'] = 'other';
    x.h.setConfig('previewMode', 'Single Preview');
    await x.h.until(() => !('*.yaml' in x.h.state.editorAssociations));
    assert.deepStrictEqual(x.h.state.editorAssociations, { '*.json': 'other' });
    x.dispose();
  });

  test('automatic preview opens beside, honours scheme and pattern exclusions', async () => {
    const x = boot({ config: { automaticallyShowPreviewOfYamlBeingEdited: true, disableAutoPreviewForFilePatterns: ['**/b.yaml'], previewMode: 'Multiple Previews' } });
    const a = x.h.openDoc(A); x.h.activate(a.uri);
    await x.h.until(() => x.h.panels.length === 1);
    assert.strictEqual(x.h.panels[0].viewColumn, -2);
    const b = x.h.openDoc(B); x.h.activate(b.uri);
    await x.h.sleep(80);
    assert.strictEqual(x.h.panels.length, 1, 'pattern-excluded file gets no auto preview');
    x.dispose();
  });

  test('non-YAML documents never trigger previews', async () => {
    const x = boot({ config: { automaticallyShowPreviewOfYamlBeingEdited: true, previewMode: 'Multiple Previews' } });
    const t = x.h.openDoc(write(dir, 'notes.txt', 'hello'));
    x.h.activate(t.uri);
    await x.h.sleep(60);
    assert.strictEqual(x.h.panels.length, 0);
    await x.h.run('openPreviewToTheSide');
    assert.strictEqual(x.h.panels.length, 0);
    assert.ok(x.h.log.warn.some((m) => /open a YAML file/.test(m)));
    x.dispose();
  });
});

suite('host: views, settings and toolbar', function () {
  this.timeout(60000);
  let dir;
  suiteSetup(() => { dir = tmpDir(); });
  const open = async (x, text = SIMPLE, name = 'v.yaml') => {
    const d = x.h.openDoc(write(dir, name, text));
    await x.h.run('openPreviewToTheSide');
    const panel = x.h.panels[0];
    await x.h.until(() => html(panel));
    return { ...d, panel };
  };

  test('switching view renders only that view', async () => {
    const x = boot();
    const { panel } = await open(x);
    const views = () => [...dom(html(panel)).querySelectorAll('main .view')].map((v) => v.className);
    assert.deepStrictEqual(views(), ['view view-tree']);
    panel.receive({ command: 'setView', view: 'json' });
    const upd = await x.h.until(() => panel.messages('update').at(-1));
    assert.strictEqual(upd.view, 'json');
    assert.ok(/class="view view-json"/.test(upd.content) && !/class="view view-tree"/.test(upd.content));
    assert.ok(!upd.outline.includes('ol-document'), 'outline variant follows the view');
    x.dispose();
  });

  test('the setView command offers all four views and applies the pick', async () => {
    const x = boot();
    const { panel } = await open(x);
    x.h.state.nextPick.push((items) => items.find((i) => /Document/.test(i.label)));
    await x.h.run('setView');
    assert.deepStrictEqual(x.h.log.quickPicks[0].map((i) => i.label.replace('$(check) ', '')), ['Tree', 'Document', 'JSON', 'Resolved']);
    const upd = await x.h.until(() => panel.messages('update').at(-1));
    assert.strictEqual(upd.view, 'document');
    x.dispose();
  });

  test('changing a setting rebuilds the page with the new theme and colour-scheme mode', async () => {
    const x = boot();
    const { panel } = await open(x);
    const before = html(panel);
    x.h.setConfig('previewTheme', 'dracula');
    await x.h.until(() => html(panel) !== before);
    assert.ok(html(panel).includes('--bg:#282a36'));
    x.h.setConfig('previewColorScheme', 'systemColorScheme');
    await x.h.until(() => /prefers-color-scheme: dark/.test(html(panel)));
    x.h.setConfig('previewColorScheme', 'editorColorScheme');
    await x.h.until(() => /body\.vscode-dark/.test(html(panel)));
    x.dispose();
  });

  test('toolbar buttons toggle real settings and the page reflects them', async () => {
    const x = boot();
    const { panel } = await open(x);
    assert.ok(/data-opt="autoTables" class="on"/.test(html(panel)));
    panel.receive({ command: 'toggleOption', name: 'autoTables' });
    await x.h.until(() => x.h.state.config['yaml-preview-enhanced.autoTables'] === false);
    await x.h.until(() => /data-opt="autoTables" class=""/.test(html(panel)));
    for (const [name, key, seq] of [['sortKeys', 'sortKeys', ['asc', 'desc', 'none']], ['markdown', 'renderMarkdownInStrings', ['byKey', 'all', 'off']]]) {
      for (const want of seq) {
        panel.receive({ command: 'toggleOption', name });
        await x.h.until(() => x.h.state.config[`yaml-preview-enhanced.${key}`] === want);
      }
    }
    x.dispose();
  });

  test('toggle commands flip their settings', async () => {
    const x = boot();
    for (const [cmd, key] of [['toggleScrollSync', 'scrollSync'], ['toggleLiveUpdate', 'liveUpdate'], ['toggleComments', 'showComments']]) {
      await x.h.run(cmd);
      assert.strictEqual(x.h.state.config[`yaml-preview-enhanced.${key}`], false, key);
      await x.h.run(cmd);
      assert.strictEqual(x.h.state.config[`yaml-preview-enhanced.${key}`], true, key);
    }
    x.dispose();
  });

  test('toolbar actions reach the page: expand, collapse, search', async () => {
    const x = boot();
    const { panel } = await open(x);
    await x.h.run('expandAll'); await x.h.run('collapseAll'); await x.h.run('focusSearch');
    assert.deepStrictEqual(panel.posted.filter((m) => ['expandAll', 'collapseAll', 'focusSearch'].includes(m.command)).map((m) => m.command), ['expandAll', 'collapseAll', 'focusSearch']);
    x.dispose();
  });

  test('imagePreview=all widens the CSP to https images, and only then', async () => {
    const x = boot({ config: { imagePreview: 'all' } });
    const { panel } = await open(x);
    assert.match(html(panel), /img-src vscode-webview-resource: data: https:;/);
    x.dispose();
  });

  test('local images resolve through the webview, relative to the YAML file', async () => {
    const x = boot();
    write(dir, 'pics/logo.png', 'x');
    const { panel } = await open(x, 'logo: pics/logo.png\n', 'img.yaml');
    const img = dom(html(panel)).querySelector('.thumb img');
    assert.ok(img && /^vscode-webview-resource:\/\/x\/.*\/pics\/logo\.png$/.test(img.src), img && img.src);
    x.dispose();
  });

  test('a file over maxFileSize shows a notice instead of rendering', async () => {
    const x = boot({ config: { maxFileSize: 20 } });
    const { panel } = await open(x, SIMPLE + 'padding: ' + 'x'.repeat(50) + '\n', 'big.yaml');
    assert.match(dom(html(panel)).querySelector('main .notice').textContent, /above the .* limit set by .*maxFileSize/);
    assert.strictEqual(dom(html(panel)).querySelectorAll('main .view').length, 0);
    x.dispose();
  });
});
