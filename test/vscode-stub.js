/**
 * A small in-memory implementation of the parts of the `vscode` API that the
 * extension uses, so the *built* extension can be driven in unit tests.
 * `Uri` is the real implementation from `vscode-uri` (what VS Code itself uses).
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { URI, Utils } = require('vscode-uri');

const manifest = require('../package.json');

class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn && this.fn(); } }
class EventEmitter {
  constructor() { this.l = new Set(); this.event = (cb) => { this.l.add(cb); return new Disposable(() => this.l.delete(cb)); }; }
  fire(e) { for (const cb of [...this.l]) cb(e); }
}

// In VS Code `vscode.Uri` is a class (so `x instanceof vscode.Uri` works) with
// static `file`, `parse` and `joinPath`; vscode-uri's URI is that same class.
const Uri = URI;
Uri.joinPath = (u, ...p) => Utils.joinPath(u, ...p);

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Selection extends Range { constructor(a, b) { super(a, b); this.anchor = a; this.active = b; } }
class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; } }
class WorkspaceEdit { constructor() { this.ops = []; } insert(uri, pos, text) { this.ops.push({ type: 'insert', uri, pos, text }); } replace(uri, range, text) { this.ops.push({ type: 'replace', uri, range, text }); } }

function createVscode() {
  const log = { info: [], warn: [], error: [], status: [], opened: [], clipboard: '', quickPicks: [], saved: [] };
  const state = {
    config: {},            // 'yaml-preview-enhanced.key' -> value (user level)
    docs: new Map(),       // uri string -> { text }
    workspaceFolders: [],
    trusted: true,
    nextSave: [],          // queue of Uris for showSaveDialog
    nextPick: [],          // queue of values for showQuickPick
    openedWith: [],
    editorAssociations: undefined,
  };
  const ev = {
    docChange: new EventEmitter(), docSave: new EventEmitter(), docClose: new EventEmitter(),
    config: new EventEmitter(), activeEditor: new EventEmitter(), visible: new EventEmitter(), selection: new EventEmitter(),
  };

  const defaults = {};
  for (const [k, v] of Object.entries(manifest.contributes.configuration.properties)) defaults[k] = v.default;

  function makeDoc(uri) {
    const key = uri.toString();
    if (!state.docs.has(key)) state.docs.set(key, { text: fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : '' });
    const rec = state.docs.get(key);
    const langId = /\.ya?ml$/i.test(uri.path) ? 'yaml' : 'plaintext';
    return {
      uri, fileName: uri.fsPath, languageId: langId, version: 1,
      getText: () => rec.text,
      get lineCount() { return rec.text.split('\n').length; },
      lineAt: (i) => { const t = rec.text.split('\n')[i] ?? ''; return { text: t, range: new Range(i, 0, i, t.length) }; },
    };
  }

  const workspace = {
    get workspaceFolders() { return state.workspaceFolders.length ? state.workspaceFolders : undefined; },
    get isTrusted() { return state.trusted; },
    getWorkspaceFolder: (uri) => state.workspaceFolders.find((f) => uri.path.startsWith(f.uri.path)),
    asRelativePath: (u) => { const f = state.workspaceFolders.find((x) => (u.path ?? u).startsWith(x.uri.path)); return f ? (u.path ?? u).slice(f.uri.path.length + 1) : (u.fsPath ?? String(u)); },
    getConfiguration: (section) => ({
      get: (key, dflt) => {
        const full = section ? `${section}.${key}` : key;
        if (section === 'workbench' && key === 'editorAssociations') return state.editorAssociations;
        if (full in state.config) return state.config[full];
        if (full in defaults) return defaults[full];
        return dflt;
      },
      update: async (key, value) => {
        const full = section ? `${section}.${key}` : key;
        if (section === 'workbench' && key === 'editorAssociations') state.editorAssociations = value;
        else state.config[full] = value;
        ev.config.fire({ affectsConfiguration: (s) => full === s || full.startsWith(s + '.') });
      },
    }),
    openTextDocument: async (uri) => makeDoc(uri),
    fs: {
      stat: async (uri) => { const st = fs.statSync(uri.fsPath); return { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, type: 1 }; },
      readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
      writeFile: async (uri, data) => { fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true }); fs.writeFileSync(uri.fsPath, Buffer.from(data)); },
    },
    findFiles: async () => [],
    applyEdit: async (edit) => {
      for (const op of edit.ops) {
        const rec = state.docs.get(op.uri.toString()) || makeDoc(op.uri) && state.docs.get(op.uri.toString());
        const lines = rec.text.split('\n');
        if (op.type === 'insert') rec.text = op.text + rec.text;
        else if (op.type === 'replace') { lines[op.range.start.line] = op.text; rec.text = lines.join('\n'); }
      }
      return true;
    },
    onDidChangeTextDocument: ev.docChange.event,
    onDidSaveTextDocument: ev.docSave.event,
    onDidCloseTextDocument: ev.docClose.event,
    onDidChangeConfiguration: ev.config.event,
  };

  const panels = [];
  const editors = { active: undefined, visible: [] };
  const customEditors = {};
  const commandsMap = new Map();

  function makePanel(viewType, title, showOptions, options) {
    const msgEv = new EventEmitter(); const disposeEv = new EventEmitter(); const viewEv = new EventEmitter();
    const panel = {
      viewType, title, viewColumn: typeof showOptions === 'object' ? showOptions.viewColumn : showOptions, options, active: true, visible: true, disposed: false,
      posted: [],
      webview: {
        html: '', options, cspSource: 'vscode-webview-resource:',
        postMessage: async (m) => { panel.posted.push(m); return true; },
        onDidReceiveMessage: msgEv.event,
        asWebviewUri: (u) => URI.parse(`vscode-webview-resource://x${u.path}`),
      },
      reveal(col) { panel.revealedWith = col; },
      dispose() { if (panel.disposed) return; panel.disposed = true; disposeEv.fire(); },
      onDidDispose: disposeEv.event, onDidChangeViewState: viewEv.event,
      // test helpers
      receive: (m) => msgEv.fire(m),
      messages: (cmd) => panel.posted.filter((m) => m.command === cmd),
    };
    panels.push(panel);
    return panel;
  }

  const window = {
    get activeTextEditor() { return editors.active; },
    get visibleTextEditors() { return editors.visible; },
    createWebviewPanel: (vt, title, show, opts) => makePanel(vt, title, show, opts),
    registerCustomEditorProvider: (viewType, provider) => { customEditors[viewType] = provider; return new Disposable(); },
    showInformationMessage: async (m, ...items) => { log.info.push(m); return log.nextChoice ?? undefined; },
    showWarningMessage: async (m) => { log.warn.push(m); },
    showErrorMessage: async (m) => { log.error.push(m); },
    setStatusBarMessage: (m) => { log.status.push(m); return new Disposable(); },
    showQuickPick: async (items) => { log.quickPicks.push(items); return state.nextPick.length ? state.nextPick.shift()(items) : undefined; },
    showSaveDialog: async () => state.nextSave.shift(),
    showOpenDialog: async () => undefined,
    showInputBox: async () => undefined,
    showTextDocument: async (doc, a, b) => {
      let ed = editors.visible.find((e) => e.document.uri.toString() === doc.uri.toString());
      if (!ed) { ed = makeEditor(doc, typeof a === 'object' ? a.viewColumn : a); editors.visible.push(ed); }
      editors.active = ed; return ed;
    },
    withProgress: async (_o, task) => task(),
    onDidChangeActiveTextEditor: ev.activeEditor.event,
    onDidChangeTextEditorVisibleRanges: ev.visible.event,
    onDidChangeTextEditorSelection: ev.selection.event,
  };

  function makeEditor(document, viewColumn) {
    const ed = { document, viewColumn, selection: new Selection(new Position(0, 0), new Position(0, 0)), revealed: [],
      revealRange(range, type) { ed.revealed.push({ range, type }); } };
    return ed;
  }

  const commands = {
    registerCommand: (id, fn) => { commandsMap.set(id, fn); return new Disposable(() => commandsMap.delete(id)); },
    executeCommand: async (id, ...args) => {
      if (id === 'vscode.openWith') { state.openedWith.push(args); return; }
      if (id === 'vscode.open') { log.opened.push(args[0]); return; }
      if (!commandsMap.has(id)) throw new Error(`command '${id}' not found`);
      return commandsMap.get(id)(...args);
    },
  };

  const diagCollections = [];
  const languages = { createDiagnosticCollection: (name) => {
    const m = new Map();
    const c = { name, set: (u, d) => m.set(u.toString(), d), delete: (u) => m.delete(u.toString()), get: (u) => m.get(u.toString()), dispose() {}, __map: m };
    diagCollections.push(c); return c; } };

  const vscode = {
    Uri, Position, Range, Selection, Diagnostic, WorkspaceEdit, EventEmitter, Disposable,
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    ProgressLocation: { Notification: 15 },
    TextEditorRevealType: { InCenter: 0, InCenterIfOutsideViewport: 2, AtTop: 3 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    workspace, window, commands, languages,
    env: {
      clipboard: { writeText: async (t) => { log.clipboard = t; }, readText: async () => log.clipboard },
      openExternal: async (u) => { log.opened.push(u); return true; },
    },
  };

  /** Test helpers (not part of the real API). */
  const helpers = {
    log, state, panels, commandsMap, customEditors, diagCollections, editors,
    openDoc(file, text) {
      const uri = Uri.file(file);
      const doc = makeDoc(uri);
      if (text !== undefined) { state.docs.get(uri.toString()).text = text; }
      const ed = makeEditor(doc, 1);
      editors.visible = editors.visible.filter((e) => e.document.uri.toString() !== uri.toString());
      editors.visible.push(ed); editors.active = ed;
      return { uri, doc, editor: ed };
    },
    activate(uri) { const ed = editors.visible.find((e) => e.document.uri.toString() === uri.toString()); editors.active = ed; ev.activeEditor.fire(ed); },
    edit(uri, text) { state.docs.get(uri.toString()).text = text; ev.docChange.fire({ document: makeDoc(uri), contentChanges: [] }); },
    save(uri) { ev.docSave.fire(makeDoc(uri)); },
    setConfig(key, value) { state.config[`yaml-preview-enhanced.${key}`] = value; ev.config.fire({ affectsConfiguration: (s) => `yaml-preview-enhanced.${key}`.startsWith(s) }); },
    fireSelection(uri, line) { const ed = editors.visible.find((e) => e.document.uri.toString() === uri.toString()); ev.selection.fire({ textEditor: ed, selections: [new Selection(new Position(line, 0), new Position(line, 0))] }); },
    fireVisible(uri, line) { const ed = editors.visible.find((e) => e.document.uri.toString() === uri.toString()); ev.visible.fire({ textEditor: ed, visibleRanges: [new Range(line, 0, line + 20, 0)] }); },
    async run(cmd, ...args) { return commands.executeCommand(`yaml-preview-enhanced.${cmd}`, ...args); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async until(fn, ms = 20000, step = 25) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await helpers.sleep(step); } throw new Error('timed out waiting for condition: ' + fn.toString().slice(0, 140)); },
    context(extensionPath) { return { extensionUri: Uri.file(extensionPath), subscriptions: [] }; },
  };
  return { vscode, helpers };
}

/** Make `require('vscode')` return `stub` while `fn` loads modules. */
function withStub(stub, fn) {
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? stub : orig.call(this, request, ...rest); };
  try { return fn(); } finally { Module._load = orig; }
}

module.exports = { createVscode, withStub, Uri };
