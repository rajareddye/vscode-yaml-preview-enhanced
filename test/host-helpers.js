const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');
const { createVscode, withStub, Uri } = require('./vscode-stub');

const ROOT = path.join(__dirname, '..');
const VT = 'yaml-preview-enhanced';
const JAR = '/usr/local/bin/plantuml.jar';
const REQ = fs.readFileSync(path.join(__dirname, 'fixtures', 'requirements.yaml'), 'utf8');

let sharedDiagrams; // one JVM cache for the whole run keeps the suite fast

/**
 * Boot the built extension against a fresh vscode stub.
 * `platform` overrides replace parts of the default desktop platform.
 */
function boot({ config = {}, trusted = true, folders = [], platform: over = {}, configDir } = {}) {
  const { vscode, helpers: h } = createVscode();
  h.state.workspaceFolders = folders.map((f) => ({ uri: Uri.file(f), name: path.basename(f) }));
  h.state.trusted = trusted;
  const cfgDir = configDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ype-cfg-'));
  for (const [k, v] of Object.entries({ liveUpdateDebounceMs: 10, configPath: cfgDir, ...config })) {
    h.state.config[`yaml-preview-enhanced.${k}`] = v;
  }
  const bundle = require.resolve('../out/host/index.js');
  delete require.cache[bundle];
  const host = withStub(vscode, () => require(bundle));
  sharedDiagrams ??= new host.NativeDiagramService();
  const calls = { chrome: [], temp: [] };
  const platform = {
    isWeb: false,
    diagrams: sharedDiagrams,
    customization: new host.NativeCustomization(() => host.readConfig()),
    nativeExport: {
      exportWithChrome: async (html, kind, outPath, cfg, width) => { calls.chrome.push({ html, kind, outPath, cfg, width }); fs.writeFileSync(outPath, 'FAKE-' + kind); },
      writeTempHtml: async (html) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ype-tmp-')), 'p.html'); fs.writeFileSync(f, html); calls.temp.push(f); return f; },
    },
    ...over,
  };
  const ctx = h.context(ROOT);
  const provider = host.activateCommon(ctx, platform);
  return { host, vscode, h, provider, platform, calls, cfgDir, ctx, dispose: () => provider.dispose() };
}

function tmpDir(prefix = 'ype-work-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const dom = (html) => new JSDOM(html).window.document;

/** Open `file` in the stub editor and return handles. */
function write(dir, name, text) {
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

module.exports = { boot, tmpDir, write, dom, ROOT, VT, JAR, REQ, Uri };
