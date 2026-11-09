import * as vscode from 'vscode';
import {
  DiagramRef,
  DiagramResult,
  ParsedYaml,
  RenderOptions,
  RenderResult,
  ViewName,
  buildPage,
  compileMasks,
  diagramInnerHtml,
  getByPointer,
  isAllowedUrl,
  matchGlob,
  parsePointer,
  parseProtocols,
  parseYaml,
  renderPreview,
  statusHtml,
  toJsonText,
  toResolvedYaml,
  transformValue,
} from './engine';
import {
  Config,
  SECTION,
  applyOverrides,
  readConfig,
  toParseOptions,
  toPlantUmlSettings,
  toRenderOptions,
} from './config';
import type { Platform } from './platform';
import { applySchema } from './schema-loader';

export const VIEW_TYPE_EDITOR = 'yaml-preview-enhanced';
const VIEW_TYPE_PANEL = 'yaml-preview-enhanced.preview';

/** Language ids that are YAML dialects. */
export const YAML_LANGUAGE_IDS = new Set([
  'yaml',
  'dockercompose',
  'github-actions-workflow',
  'ansible',
  'azure-pipelines',
  'home-assistant',
]);

const OPTION_COMMANDS: Record<string, string> = {
  autoTables: 'toggleAutoTables',
  showComments: 'toggleComments',
  sortKeys: 'toggleSortKeys',
  markdown: 'toggleMarkdownInStrings',
};

interface Preview {
  id: number;
  panel: vscode.WebviewPanel;
  uri: vscode.Uri;
  /** The shared panel of "Single Preview" mode. */
  single: boolean;
  locked: boolean;
  /** Opened by the custom editor ("Previews Only"). */
  custom: boolean;
  view: ViewName;
  disposed: boolean;
  /** Bumped per render; stale async results are dropped. */
  token: number;
  timer?: ReturnType<typeof setTimeout>;
  parsed?: ParsedYaml;
  lastDiagrams: DiagramRef[];
  sentDiagrams: Set<string>;
  diagramFingerprint: string;
  disposables: vscode.Disposable[];
}

export interface Computed {
  parsed: ParsedYaml;
  render: RenderResult;
  /** Content after `parser.js` hooks. */
  content: string;
  cfg: Config;
}

const dirOf = (u: vscode.Uri) => u.with({ path: u.path.replace(/\/[^/]*$/, '') || '/' });
const baseName = (u: vscode.Uri) => u.path.split('/').pop() || u.path;

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export class PreviewProvider implements vscode.Disposable {
  private readonly previews = new Set<Preview>();
  private single: Preview | undefined;
  private active: Preview | undefined;
  private nextId = 1;
  /** hash → source/result, for "copy source" and "save SVG" (bounded). */
  private readonly store = new Map<string, { source: string; result?: DiagramResult }>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('yaml-preview-enhanced');
  private readonly disposables: vscode.Disposable[] = [];
  /** Editor events before this time are our own doing (avoid sync loops). */
  private blockEditorEventsUntil = 0;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly platform: Platform,
  ) {
    const w = vscode.workspace;
    const win = vscode.window;
    this.disposables.push(
      this.diagnostics,
      w.onDidChangeTextDocument((e) => this.onDocumentChange(e)),
      w.onDidSaveTextDocument((d) => this.onDocumentSave(d)),
      w.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)),
      w.onDidChangeConfiguration((e) => this.onConfigChange(e)),
      win.onDidChangeActiveTextEditor((ed) => this.onActiveEditor(ed)),
      win.onDidChangeTextEditorVisibleRanges((e) => this.onVisibleRanges(e)),
      win.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
    );
  }

  dispose(): void {
    for (const p of [...this.previews]) {
      p.panel.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
  }

  /* ---------------------------------------------------------------- */
  /* Configuration                                                    */
  /* ---------------------------------------------------------------- */

  /** Settings plus `config.js` overrides. */
  async effectiveConfig(resource?: vscode.Uri): Promise<Config> {
    const base = readConfig(resource);
    try {
      const overrides = await this.platform.customization.loadConfigOverrides(resource, base);
      return applyOverrides(base, overrides);
    } catch {
      return base;
    }
  }

  isYaml(doc: vscode.TextDocument): boolean {
    if (YAML_LANGUAGE_IDS.has(doc.languageId)) {
      return true;
    }
    const cfg = readConfig(doc.uri);
    return cfg.yamlFileExtensions.some((e) => doc.fileName.toLowerCase().endsWith(e.toLowerCase()));
  }

  /* ---------------------------------------------------------------- */
  /* Opening & lifecycle                                              */
  /* ---------------------------------------------------------------- */

  private roots(uri: vscode.Uri): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.ctx.extensionUri, 'out'),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
      dirOf(uri),
    ];
  }

  private title(p: Pick<Preview, 'uri' | 'locked'>): string {
    return `${p.locked ? '🔒 ' : ''}Preview ${baseName(p.uri)}`;
  }

  previewsFor(uri: vscode.Uri): Preview[] {
    return [...this.previews].filter((p) => p.uri.toString() === uri.toString());
  }

  /** The preview a command should act on. */
  target(uri?: vscode.Uri): Preview | undefined {
    if (this.active && !this.active.disposed && this.active.panel.active) {
      return this.active;
    }
    const doc = uri ?? vscode.window.activeTextEditor?.document.uri;
    return (
      (doc && this.previewsFor(doc).find((p) => p.panel.visible)) ||
      (doc && this.previewsFor(doc)[0]) ||
      this.single ||
      [...this.previews][0]
    );
  }

  /** `Open Preview` / `Open Preview to the Side` / `Open Locked Preview…`. */
  async open(
    uri: vscode.Uri,
    opts: { side: boolean; locked?: boolean; preserveFocus?: boolean },
  ): Promise<void> {
    const cfg = readConfig(uri);
    if (cfg.previewMode === 'Previews Only') {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        VIEW_TYPE_EDITOR,
        opts.side ? vscode.ViewColumn.Beside : undefined,
      );
      return;
    }
    const column = opts.side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const locked = !!opts.locked;

    if (cfg.previewMode === 'Single Preview' && !locked && this.single && !this.single.disposed) {
      const p = this.single;
      p.locked = false;
      if (p.uri.toString() !== uri.toString()) {
        await this.retarget(p, uri);
      }
      p.panel.reveal(column, opts.preserveFocus);
      return;
    }
    const existing = [...this.previews].find(
      (p) => !p.single && !p.custom && !p.disposed && p.uri.toString() === uri.toString() && p.locked === locked,
    );
    if (existing && cfg.previewMode === 'Multiple Previews') {
      existing.panel.reveal(column, opts.preserveFocus);
      return;
    }
    const single = cfg.previewMode === 'Single Preview' && !locked;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE_PANEL,
      `Preview ${baseName(uri)}`,
      { viewColumn: column, preserveFocus: opts.preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: this.roots(uri),
      },
    );
    await this.adopt(panel, uri, { single, locked, custom: false });
  }

  /** Called by the custom editor provider ("Previews Only"). */
  async adoptCustomEditor(panel: vscode.WebviewPanel, doc: vscode.TextDocument): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.roots(doc.uri),
    };
    await this.adopt(panel, doc.uri, { single: false, locked: false, custom: true });
  }

  private async adopt(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    o: { single: boolean; locked: boolean; custom: boolean },
  ): Promise<void> {
    const cfg = readConfig(uri);
    const p: Preview = {
      id: this.nextId++,
      panel,
      uri,
      single: o.single,
      locked: o.locked,
      custom: o.custom,
      view: cfg.defaultView,
      disposed: false,
      token: 0,
      lastDiagrams: [],
      sentDiagrams: new Set(),
      diagramFingerprint: '',
      disposables: [],
    };
    this.previews.add(p);
    if (o.single) {
      this.single = p;
    }
    this.active = p;
    if (!o.custom) {
      panel.title = this.title(p);
    }
    p.disposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(p, m)),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
          this.active = p;
        }
      }),
      panel.onDidDispose(() => this.onDispose(p)),
    );
    await this.render(p, { full: true });
  }

  private onDispose(p: Preview): void {
    p.disposed = true;
    clearTimeout(p.timer);
    p.disposables.forEach((d) => d.dispose());
    this.previews.delete(p);
    if (this.single === p) {
      this.single = undefined;
    }
    if (this.active === p) {
      this.active = undefined;
    }
    if (this.previewsFor(p.uri).length === 0) {
      this.diagnostics.delete(p.uri);
    }
  }

  private async retarget(p: Preview, uri: vscode.Uri): Promise<void> {
    p.uri = uri;
    p.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.roots(uri),
    };
    p.panel.title = this.title(p);
    await this.render(p, { full: true });
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */

  private resolveImage(p: Pick<Preview, 'uri' | 'panel'>): (raw: string) => string | undefined {
    const base = dirOf(p.uri);
    return (raw) => {
      try {
        // joinPath normalises `..`; the webview only serves allowed roots.
        return p.panel.webview.asWebviewUri(vscode.Uri.joinPath(base, raw)).toString();
      } catch {
        return undefined;
      }
    };
  }

  /**
   * Parse, validate and render a document. Used by the live preview (one
   * view) and by exports (all views).
   */
  async compute(
    uri: vscode.Uri,
    renderExtra: Partial<RenderOptions> = {},
    cfgOverride?: Config,
  ): Promise<Computed> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const cfg = cfgOverride ?? (await this.effectiveConfig(uri));
    let text = doc.getText();

    if (cfg.maxFileSize > 0 && text.length > cfg.maxFileSize) {
      const mb = (text.length / 1048576).toFixed(1);
      const parsed = parseYaml('');
      const notice = `<section class="doc"><div class="notice sev-warning">This file is ${mb} MB, above the ${(cfg.maxFileSize / 1048576).toFixed(1)} MB limit set by <code>yaml-preview-enhanced.maxFileSize</code>, so it is not rendered. Raise the limit (or set it to 0) to preview it.</div></section>`;
      return {
        parsed,
        cfg,
        content: notice, // the page shows `content`, so it must carry the notice
        render: {
          content: notice,
          outline: '',
          meta: { docCount: 0, errorCount: 0, warningCount: 0, schemaIssueCount: 0, nodeCount: 0, lineCount: 0, docLabels: [] },
          diagrams: [],
        },
      };
    }

    const hooks = await this.platform.customization.loadParserHooks(uri, cfg);
    for (const h of hooks) {
      if (h.onWillParseYaml) {
        text = await h.onWillParseYaml(text, { uri: uri.toString() });
      }
    }
    const parsed = parseYaml(text, toParseOptions(cfg));
    await applySchema(parsed, uri, cfg);
    const render = renderPreview(parsed, toRenderOptions(cfg, renderExtra));
    let content = render.content;
    for (const h of hooks) {
      if (h.onDidParseYaml) {
        content = await h.onDidParseYaml(content, { uri: uri.toString() });
      }
    }
    return { parsed, render, content, cfg };
  }

  /** Settings the page can change without being rebuilt. */
  private liveConfig(cfg: Config) {
    return {
      scrollSync: cfg.scrollSync,
      zen: cfg.enablePreviewZenMode,
      contextMenu: cfg.enablePreviewContextMenu,
      vscodeMenu: cfg.useVSCodeThemeForContextMenu,
      lightbox: cfg.enableImageLightbox,
      sortKeys: cfg.sortKeys,
    };
  }

  private clientConfig(cfg: Config, view: ViewName) {
    return { host: true, view, diagrams: {}, ...this.liveConfig(cfg) };
  }

  private toggles(cfg: Config) {
    return {
      autoTables: cfg.autoTables,
      showComments: cfg.showComments,
      sortKeys: cfg.sortKeys,
      markdown: cfg.renderMarkdownInStrings,
    };
  }

  async render(p: Preview, opts: { full?: boolean } = {}): Promise<void> {
    if (p.disposed) {
      return;
    }
    const token = ++p.token;
    let c: Computed;
    try {
      c = await this.compute(p.uri, {
        views: [p.view],
        resolveImage: this.resolveImage(p),
      });
    } catch (e) {
      if (token === p.token && !p.disposed) {
        p.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1em"><p><b>Could not render ${baseName(p.uri)}</b></p><pre>${String(
          e instanceof Error ? e.message : e,
        ).replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</pre></body></html>`;
      }
      return;
    }
    if (token !== p.token || p.disposed) {
      return; // a newer render is already on its way
    }
    p.parsed = c.parsed;
    this.publishDiagnostics(p.uri, c);

    if (opts.full) {
      p.sentDiagrams.clear();
      p.panel.webview.html = await this.page(p, c);
    } else {
      void p.panel.webview.postMessage({
        command: 'update',
        content: c.content,
        outline: c.render.outline,
        status: statusHtml(c.render.meta),
        view: p.view,
        toggles: this.toggles(c.cfg),
        config: this.liveConfig(c.cfg),
      });
    }
    p.lastDiagrams = c.render.diagrams;
    this.dispatchDiagrams(p, c.render.diagrams, c.cfg);
  }

  private async page(p: Preview, c: Computed): Promise<string> {
    const webview = p.panel.webview;
    const n = nonce();
    const [css, head] = await Promise.all([
      this.platform.customization.loadCss(p.uri),
      this.platform.customization.loadHead(p.uri),
    ]);
    return buildPage({
      title: baseName(p.uri),
      content: c.content,
      outline: c.render.outline,
      meta: c.render.meta,
      theme: c.cfg.previewTheme,
      scheme: c.cfg.previewColorScheme,
      view: p.view,
      client: this.clientConfig(c.cfg, p.view),
      toggles: this.toggles(c.cfg),
      csp: { nonce: n, cspSource: webview.cspSource, remoteImages: c.cfg.imagePreview === 'all' },
      scriptSrc: webview
        .asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'webview', 'preview.js'))
        .toString(),
      customCss: css,
      headHtml: head,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Diagrams                                                         */
  /* ---------------------------------------------------------------- */

  private post(p: Preview, message: unknown): void {
    if (!p.disposed) {
      void p.panel.webview.postMessage(message);
    }
  }

  private remember(hash: string, source: string, result?: DiagramResult): void {
    this.store.delete(hash);
    this.store.set(hash, { source, result });
    while (this.store.size > 400) {
      this.store.delete(this.store.keys().next().value as string);
    }
  }

  /** Render diagrams the page does not have yet and stream them in. */
  private dispatchDiagrams(p: Preview, refs: DiagramRef[], cfg: Config): void {
    if (!cfg.plantumlEnabled || refs.length === 0) {
      return;
    }
    const settings = toPlantUmlSettings(cfg);
    const fingerprint = JSON.stringify(settings);
    if (p.diagramFingerprint !== fingerprint) {
      // Jar/Java/profile changed: what the page holds may be stale.
      p.diagramFingerprint = fingerprint;
      p.sentDiagrams.clear();
      this.post(p, { command: 'resetDiagrams' });
    }
    for (const ref of refs) {
      if (p.sentDiagrams.has(ref.hash)) {
        continue;
      }
      p.sentDiagrams.add(ref.hash);
      this.remember(ref.hash, ref.source);
      void this.platform.diagrams.render(ref.source, settings).then((result) => {
        this.remember(ref.hash, ref.source, result);
        this.post(p, {
          command: 'diagram',
          hash: ref.hash,
          html: diagramInnerHtml(result, ref.source),
        });
      });
    }
  }

  /** Forget cached results and render every diagram again. */
  async refreshDiagrams(): Promise<void> {
    this.platform.diagrams.clear();
    for (const p of this.previews) {
      p.sentDiagrams.clear();
      p.diagramFingerprint = '';
      const cfg = await this.effectiveConfig(p.uri);
      this.dispatchDiagrams(p, p.lastDiagrams, cfg);
    }
  }

  diagramBySource(hash: string) {
    return this.store.get(hash);
  }

  /* ---------------------------------------------------------------- */
  /* Diagnostics                                                      */
  /* ---------------------------------------------------------------- */

  private publishDiagnostics(uri: vscode.Uri, c: Computed): void {
    if (!c.cfg.publishDiagnostics) {
      this.diagnostics.delete(uri);
      return;
    }
    const out: vscode.Diagnostic[] = [];
    for (const d of c.parsed.docs) {
      for (const i of [...d.errors, ...d.warnings, ...d.schemaIssues]) {
        const range = new vscode.Range(
          Math.max(0, i.line - 1),
          Math.max(0, i.col - 1),
          Math.max(0, i.endLine - 1),
          Math.max(0, i.endCol - 1),
        );
        const diag = new vscode.Diagnostic(
          range,
          i.message,
          i.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : i.severity === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information,
        );
        diag.source = i.source === 'schema' ? 'YAML Preview (schema)' : 'YAML Preview';
        if (i.code) {
          diag.code = i.code;
        }
        out.push(diag);
      }
    }
    this.diagnostics.set(uri, out);
  }

  /* ---------------------------------------------------------------- */
  /* Editor → preview                                                 */
  /* ---------------------------------------------------------------- */

  private schedule(p: Preview): void {
    clearTimeout(p.timer);
    const wait = readConfig(p.uri).liveUpdateDebounceMs;
    p.timer = setTimeout(() => void this.render(p), wait);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    for (const p of this.previewsFor(e.document.uri)) {
      if (readConfig(p.uri).liveUpdate) {
        this.schedule(p);
      }
    }
  }

  private onDocumentSave(doc: vscode.TextDocument): void {
    for (const p of this.previewsFor(doc.uri)) {
      if (!readConfig(p.uri).liveUpdate) {
        void this.render(p);
      }
    }
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration(SECTION)) {
      for (const p of this.previews) {
        // Theme, CSP and toolbar are part of the page, so rebuild it.
        void this.render(p, { full: true });
      }
    }
  }

  /** Follow the active editor (single mode) or auto-open a preview. */
  async onActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor || !this.isYaml(editor.document)) {
      return;
    }
    const uri = editor.document.uri;
    const cfg = readConfig(uri);
    if (this.single && !this.single.locked && !this.single.disposed && cfg.previewMode === 'Single Preview') {
      if (this.single.uri.toString() !== uri.toString()) {
        await this.retarget(this.single, uri);
      }
      return;
    }
    if (
      cfg.automaticallyShowPreviewOfYamlBeingEdited &&
      cfg.previewMode !== 'Previews Only' &&
      this.previewsFor(uri).length === 0 &&
      !this.autoPreviewDisabled(uri, cfg)
    ) {
      await this.open(uri, { side: true, preserveFocus: true });
    }
  }

  private autoPreviewDisabled(uri: vscode.Uri, cfg: Config): boolean {
    if (cfg.disableAutoPreviewForUriSchemes.includes(uri.scheme)) {
      return true;
    }
    return cfg.disableAutoPreviewForFilePatterns.some((g) => matchGlob(g, uri.path));
  }

  private onVisibleRanges(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (Date.now() < this.blockEditorEventsUntil || e.visibleRanges.length === 0) {
      return;
    }
    for (const p of this.previewsFor(e.textEditor.document.uri)) {
      if (readConfig(p.uri).scrollSync) {
        this.post(p, {
          command: 'revealLine',
          line: e.visibleRanges[0].start.line + 1,
          mode: 'scroll',
        });
      }
    }
  }

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (Date.now() < this.blockEditorEventsUntil) {
      return;
    }
    for (const p of this.previewsFor(e.textEditor.document.uri)) {
      if (readConfig(p.uri).scrollSync) {
        this.post(p, {
          command: 'revealLine',
          line: e.selections[0].active.line + 1,
          mode: 'cursor',
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Preview → host                                                   */
  /* ---------------------------------------------------------------- */

  private async onMessage(p: Preview, m: Record<string, unknown>): Promise<void> {
    switch (m.command) {
      case 'ready':
        // The page (re)loaded and holds no diagrams yet.
        p.sentDiagrams.clear();
        if (p.lastDiagrams.length) {
          this.dispatchDiagrams(p, p.lastDiagrams, await this.effectiveConfig(p.uri));
        }
        break;
      case 'setView':
        p.view = m.view as ViewName;
        await this.render(p);
        break;
      case 'toggleOption': {
        const cmd = OPTION_COMMANDS[String(m.name)];
        if (cmd) {
          await vscode.commands.executeCommand(`${SECTION}.${cmd}`);
        }
        break;
      }
      case 'scrollLine':
        await this.syncEditorToPreview(p, Number(m.line));
        break;
      case 'revealLine':
        await this.showSource(p, Number(m.line), Number(m.col) || 1);
        break;
      case 'openLink': {
        const href = String(m.href);
        const cfg = readConfig(p.uri);
        if (isAllowedUrl(href, parseProtocols(cfg.protocolsWhiteList))) {
          await vscode.env.openExternal(vscode.Uri.parse(href));
        } else {
          void vscode.window.showWarningMessage(
            `yaml-preview-enhanced-r: not opening "${href.slice(0, 80)}" — its protocol is not in "protocolsWhiteList".`,
          );
        }
        break;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text));
        vscode.window.setStatusBarMessage('YAML Preview: copied to clipboard', 2000);
        break;
      case 'copyValue':
        await this.copyValue(p, Number(m.doc), String(m.ptr), m.format === 'yaml' ? 'yaml' : 'json');
        break;
      case 'copyDiagramSource': {
        const d = this.store.get(String(m.hash));
        if (d) {
          await vscode.env.clipboard.writeText(d.source);
          vscode.window.setStatusBarMessage('YAML Preview: PlantUML source copied', 2000);
        }
        break;
      }
      case 'saveDiagram':
        await vscode.commands.executeCommand(`${SECTION}.saveDiagramSvg`, String(m.hash));
        break;
      case 'export':
        await vscode.commands.executeCommand(`${SECTION}.export`);
        break;
    }
  }

  /** Copy one node's value (masked, resolved) as JSON or YAML. */
  private async copyValue(p: Preview, docIndex: number, ptr: string, format: 'json' | 'yaml'): Promise<void> {
    const doc = p.parsed?.docs[docIndex];
    const cfg = await this.effectiveConfig(p.uri);
    if (!doc || doc.json === undefined) {
      void vscode.window.showWarningMessage('YAML Preview: this value is not available (the document did not resolve).');
      return;
    }
    const masks = compileMasks(cfg.maskKeys);
    const masked = parsePointer(ptr).some((seg) => masks.some((r) => r.test(seg)));
    let value = getByPointer(doc.json, ptr);
    if (value === undefined && ptr !== '') {
      void vscode.window.showWarningMessage(
        'YAML Preview: there is no resolved value for this node (for example a merge key). Copy its parent instead.',
      );
      return;
    }
    if (masked) {
      value = '••••••';
    }
    const opts = { sortKeys: cfg.sortKeys, maskKeys: cfg.maskKeys };
    const text =
      format === 'json'
        ? toJsonText(transformValue(value, { sortKeys: 'none', maskKeys: [] }), opts)
        : toResolvedYaml(value, opts);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`YAML Preview: copied as ${format.toUpperCase()}`, 2000);
  }

  private visibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
  }

  /** The user scrolled the preview: scroll the editor to match. */
  private async syncEditorToPreview(p: Preview, line: number): Promise<void> {
    if (!readConfig(p.uri).scrollSync || line < 1) {
      return;
    }
    const editor = this.visibleEditor(p.uri);
    if (!editor) {
      return;
    }
    this.blockEditorEventsUntil = Date.now() + 450;
    const pos = new vscode.Position(line - 1, 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }

  /** Select a source position in the editor (opening it if necessary). */
  async showSource(p: Preview, line: number, col = 1): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(p.uri);
    let editor = this.visibleEditor(p.uri);
    if (!editor) {
      editor = await vscode.window.showTextDocument(doc, {
        viewColumn:
          p.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One,
        preserveFocus: false,
      });
    }
    this.blockEditorEventsUntil = Date.now() + 500;
    const pos = new vscode.Position(
      Math.min(Math.max(0, line - 1), Math.max(0, doc.lineCount - 1)),
      Math.max(0, col - 1),
    );
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await vscode.window.showTextDocument(doc, editor.viewColumn, false);
  }

  /* ---------------------------------------------------------------- */
  /* Commands that act on a preview                                   */
  /* ---------------------------------------------------------------- */

  postTo(p: Preview | undefined, message: unknown): void {
    if (p) {
      this.post(p, message);
    }
  }

  async setView(p: Preview, view: ViewName): Promise<void> {
    p.view = view;
    await this.render(p);
  }

  getView(p: Preview): ViewName {
    return p.view;
  }

  sourceOf(p: Preview): vscode.Uri {
    return p.uri;
  }

  isCustomEditor(p: Preview): boolean {
    return p.custom;
  }

  closePreview(p: Preview): void {
    p.panel.dispose();
  }

  toggleLock(): boolean | undefined {
    const p = this.single ?? this.active;
    if (!p) {
      return undefined;
    }
    p.locked = !p.locked;
    p.panel.title = this.title(p);
    return p.locked;
  }

  /** Re-render everything from scratch (e.g. after a Sync command). */
  async refresh(p: Preview): Promise<void> {
    await this.render(p, { full: true });
  }

  allPreviews(): Preview[] {
    return [...this.previews];
  }
}

export type { Preview };
