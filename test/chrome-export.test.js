const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CE = require('../out/chrome-export');
const E = require('../out/engine');
const { PlantUmlRunner } = require('../out/plantuml-runner');

const CHROME = process.env.CHROME_PATH || [ '/tmp/chromium', ...CE.chromeCandidates() ].find((p) => fs.existsSync(p));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ype-chrome-'));
const REQ = fs.readFileSync(path.join(__dirname, 'fixtures', 'requirements.yaml'), 'utf8');

async function printPage() {
  const parsed = E.parseYaml(REQ);
  const r = E.renderPreview(parsed, { ...E.DEFAULT_RENDER_OPTIONS, views: ['document'], expandDepth: 99 });
  const runner = new PlantUmlRunner();
  const diagrams = {};
  for (const d of r.diagrams) diagrams[d.hash] = E.diagramInnerHtml(await runner.render(d.source, { jarPath: '/usr/local/bin/plantuml.jar', javaPath: 'java', securityProfile: 'SANDBOX', timeoutMs: 30000, extraArgs: [] }), d.source);
  return E.buildPage({ title: 'Export', content: r.content, outline: r.outline, meta: r.meta, theme: 'github-light', scheme: 'selectedPreviewTheme', view: 'document', print: true,
    client: { host: false, view: 'document', scrollSync: false, zen: false, contextMenu: false, vscodeMenu: false, lightbox: false, sortKeys: 'none', diagrams },
    inlineScript: fs.readFileSync(path.join(__dirname, '..', 'out', 'webview', 'preview.js'), 'utf8') });
}

suite('chrome-export (pure helpers)', () => {
  test('fileUrl handles POSIX, Windows and special characters', () => {
    assert.strictEqual(CE.fileUrl('/tmp/a b/c#d.html'), 'file:///tmp/a%20b/c%23d.html');
    assert.strictEqual(CE.fileUrl('C:\\Users\\me\\x.html'), 'file:///C:/Users/me/x.html');
  });
  test('candidate list per platform, CHROME_PATH first', () => {
    assert.strictEqual(CE.chromeCandidates('linux', { CHROME_PATH: '/x/chrome' })[0], '/x/chrome');
    assert.ok(CE.chromeCandidates('darwin', {}).some((p) => p.includes('Google Chrome.app')));
    assert.ok(CE.chromeCandidates('win32', { PROGRAMFILES: 'C:\\PF' }).some((p) => p.endsWith('chrome.exe')));
  });
  test('findChrome honours an explicit path and refuses a bad one', () => {
    assert.strictEqual(CE.findChrome('/nonexistent/chrome'), undefined);
    assert.strictEqual(CE.findChrome(process.execPath), process.execPath);
  });
  test('a missing browser gives an actionable error', async () => {
    await assert.rejects(CE.exportWithChrome('<p>x</p>', { kind: 'pdf', outPath: path.join(tmp, 'x.pdf') }, { chromePath: '/nonexistent/chrome', extraArgs: [] }), /not found at "\/nonexistent\/chrome".*chromePath/);
  });
});

suite('chrome-export (real browser)', function () {
  this.timeout(120000);
  suiteSetup(function () { if (!CHROME || !fs.existsSync('/usr/local/bin/plantuml.jar')) { console.log('      (skipped: need Chrome and plantuml.jar)'); this.skip(); } });
  // The test machine's Chrome may be a headless-only build inside a container.
  const opts = (extra = {}) => ({ chromePath: CHROME, extraArgs: ['--no-sandbox'], headless: /chromium$/.test(CHROME) ? 'shell' : true, ...extra });

  test('PDF: a valid multi-element document containing the diagram', async () => {
    const out = path.join(tmp, 'out.pdf');
    await CE.exportWithChrome(await printPage(), { kind: 'pdf', outPath: out }, opts());
    const buf = fs.readFileSync(out);
    assert.strictEqual(buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buf.length > 20000, `suspiciously small PDF: ${buf.length} bytes`);
    fs.copyFileSync(out, '/tmp/qa/export.pdf');
  });

  test('PNG: correct signature and the requested dimensions', async () => {
    const out = path.join(tmp, 'out.png');
    await CE.exportWithChrome(await printPage(), { kind: 'png', outPath: out }, opts({ width: 1100 }));
    const buf = fs.readFileSync(out);
    assert.strictEqual(buf.subarray(1, 4).toString(), 'PNG');
    assert.strictEqual(buf.readUInt32BE(16), 1100, 'width');
    // full page: much taller than the 900px viewport (the diagram alone is ~700px)
    assert.ok(buf.readUInt32BE(20) > 1000, `height ${buf.readUInt32BE(20)} should cover the whole document`);
    fs.copyFileSync(out, '/tmp/qa/export.png');
  });

  test('the temp directory is removed afterwards', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('yaml-preview-')).length;
    await CE.exportWithChrome('<p>hi</p>', { kind: 'pdf', outPath: path.join(tmp, 'tiny.pdf') }, opts());
    assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('yaml-preview-')).length, before);
  });

  test('JPEG: valid image data', async () => {
    const out = path.join(tmp, 'out.jpg');
    await CE.exportWithChrome(await printPage(), { kind: 'jpeg', outPath: out }, opts());
    const buf = fs.readFileSync(out);
    assert.deepStrictEqual([...buf.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  });

  test('a browser that cannot start gives a clear error rather than hanging', async () => {
    const t = Date.now();
    await assert.rejects(CE.exportWithChrome('<p>x</p>', { kind: 'pdf', outPath: path.join(tmp, 'z.pdf') }, { chromePath: '/bin/false', extraArgs: [], timeoutMs: 8000 }), /Could not start Chrome/);
    assert.ok(Date.now() - t < 15000);
  });
});
