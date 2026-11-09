import * as vscode from 'vscode';
import {
  DiagramRef,
  ParsedYaml,
  ViewName,
  buildPage,
  diagramInnerHtml,
  esc,
  exportJson,
  exportMarkdown,
  exportResolvedYaml,
} from './engine';
import type { ColorScheme } from './engine';
import { Config, SECTION, toPlantUmlSettings } from './config';
import type { Platform } from './platform';
import { PreviewProvider } from './preview-provider';

const dirOf = (u: vscode.Uri) => u.with({ path: u.path.replace(/\/[^/]*$/, '') || '/' });
const baseName = (u: vscode.Uri) => u.path.split('/').pop() || 'document';
const stem = (u: vscode.Uri) => baseName(u).replace(/\.[^.]*$/, '') || 'document';

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export type ExportKind =
  | 'html' | 'pdf' | 'png' | 'jpeg' | 'json' | 'resolvedYaml' | 'markdown' | 'browser';

export interface ExportTarget {
  uri: vscode.Uri;
  view: ViewName;
}

export class Exporter {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly provider: PreviewProvider,
    private readonly platform: Platform,
  ) {}

  /** The document to export: the active preview's, else the active editor's. */
  resolveTarget(explicit?: vscode.Uri): ExportTarget | undefined {
    const p = this.provider.target(explicit);
    if (p) {
      return { uri: this.provider.sourceOf(p), view: this.provider.getView(p) };
    }
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && this.provider.isYaml(doc)) {
      return { uri: doc.uri, view: 'tree' };
    }
    return undefined;
  }

  private async clientScript(): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'webview', 'preview.js'),
    );
    return new TextDecoder().decode(bytes);
  }

  /** Replace `yp-img:<path>` markers with data URIs read from disk. */
  private async inlineImages(html: string, docUri: vscode.Uri, raws: Set<string>): Promise<string> {
    let out = html;
    for (const raw of raws) {
      let replacement = '';
      try {
        const uri = vscode.Uri.joinPath(dirOf(docUri), raw);
        const ext = raw.split('.').pop()?.toLowerCase().split(/[?#]/)[0] ?? '';
        const st = await vscode.workspace.fs.stat(uri);
        if (MIME[ext] && st.size <= MAX_INLINE_IMAGE) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          replacement = `data:${MIME[ext]};base64,${bytesToBase64(bytes)}`;
        }
      } catch {
        /* unreadable: leave the thumbnail empty */
      }
      out = out.split(`yp-img:${esc(raw)}`).join(replacement);
    }
    return out;
  }

  /**
   * Build a complete, self-contained page.
   *  - `standalone`: every view, interactive, theme as configured.
   *  - `print`: only `view`, everything expanded, chrome hidden (PDF/images).
   */
  async buildHtml(
    target: ExportTarget,
    mode: 'standalone' | 'print',
    cfgIn?: Config,
  ): Promise<{ html: string; diagrams: DiagramRef[]; svgHeight: number }> {
    const cfg = cfgIn ?? (await this.provider.effectiveConfig(target.uri));
    const raws = new Set<string>();
    const c = await this.provider.compute(
      target.uri,
      {
        views: mode === 'print' ? [target.view] : undefined,
        expandDepth: mode === 'print' ? 99 : cfg.defaultExpandDepth,
        resolveImage: (raw) => {
          raws.add(raw);
          return `yp-img:${raw}`;
        },
      },
      cfg,
    );

    // Render every diagram so the file does not depend on a running extension.
    const results: Record<string, string> = {};
    let svgHeight = 0;
    await Promise.all(
      c.render.diagrams.map(async (d) => {
        if (!cfg.plantumlEnabled) {
          return;
        }
        const r = await this.platform.diagrams.render(d.source, toPlantUmlSettings(cfg));
        results[d.hash] = diagramInnerHtml(r, d.source);
        const h = /<svg[^>]*\sheight="(\d+)/.exec(r.svg ?? '');
        svgHeight += h ? Number(h[1]) + 60 : 0;
      }),
    );

    const printing = mode === 'print';
    const theme = printing && !cfg.printBackground ? 'github-light' : cfg.previewTheme;
    const scheme: ColorScheme =
      printing && !cfg.printBackground
        ? 'selectedPreviewTheme'
        : cfg.exportColorScheme === 'auto'
          ? 'systemColorScheme'
          : 'selectedPreviewTheme';
    const [css, head, script] = await Promise.all([
      this.platform.customization.loadCss(target.uri),
      this.platform.customization.loadHead(target.uri),
      this.clientScript(),
    ]);

    let html = buildPage({
      title: baseName(target.uri),
      content: c.content,
      outline: c.render.outline,
      meta: c.render.meta,
      theme,
      scheme,
      view: target.view,
      print: printing,
      client: {
        host: false,
        view: target.view,
        scrollSync: false,
        zen: !printing,
        contextMenu: !printing,
        vscodeMenu: false,
        lightbox: !printing,
        sortKeys: cfg.sortKeys,
        diagrams: results,
      },
      inlineScript: script,
      customCss: css,
      headHtml: head,
    });
    html = await this.inlineImages(html, target.uri, raws);
    return { html, diagrams: c.render.diagrams, svgHeight };
  }

  /* ---------------------------------------------------------------- */

  private async save(
    uri: vscode.Uri,
    name: string,
    filters: Record<string, string[]>,
  ): Promise<vscode.Uri | undefined> {
    return vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dirOf(uri), name),
      filters,
      saveLabel: 'Export',
    });
  }

  private async write(dest: vscode.Uri, data: string): Promise<void> {
    await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(data));
  }

  private async done(dest: vscode.Uri, what: string): Promise<void> {
    const open = 'Open';
    const choice = await vscode.window.showInformationMessage(`${what} exported to ${dest.scheme === 'file' ? dest.fsPath : dest.toString()}`, open);
    if (choice === open) {
      await vscode.commands.executeCommand('vscode.open', dest);
    }
  }

  async run(kind: ExportKind, explicit?: vscode.Uri): Promise<void> {
    const target = this.resolveTarget(explicit);
    if (!target) {
      void vscode.window.showWarningMessage('YAML Preview: open a YAML file first.');
      return;
    }
    const cfg = await this.provider.effectiveConfig(target.uri);
    const name = stem(target.uri);

    switch (kind) {
      case 'html': {
        const dest = await this.save(target.uri, `${name}.html`, { HTML: ['html'] });
        if (!dest) {
          return;
        }
        const { html } = await this.buildHtml(target, 'standalone', cfg);
        await this.write(dest, html);
        await this.done(dest, 'HTML');
        return;
      }
      case 'browser': {
        const nx = this.platform.nativeExport;
        if (!nx) {
          void vscode.window.showWarningMessage('YAML Preview: "Open in Browser" is not available in the web version.');
          return;
        }
        const { html } = await this.buildHtml(target, 'standalone', cfg);
        await vscode.env.openExternal(vscode.Uri.file(await nx.writeTempHtml(html)));
        return;
      }
      case 'pdf':
      case 'png':
      case 'jpeg': {
        const nx = this.platform.nativeExport;
        if (!nx) {
          void vscode.window.showWarningMessage('YAML Preview: this export needs the desktop version of VS Code.');
          return;
        }
        const ext = kind === 'jpeg' ? 'jpg' : kind;
        const dest = await this.save(target.uri, `${name}.${ext}`, { [kind.toUpperCase()]: [ext] });
        if (!dest) {
          return;
        }
        if (dest.scheme !== 'file') {
          void vscode.window.showWarningMessage('YAML Preview: Chrome export can only write to local files.');
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Exporting ${kind.toUpperCase()}…` },
          async () => {
            const { html } = await this.buildHtml(target, 'print', cfg);
            await nx.exportWithChrome(html, kind, dest.fsPath, cfg, 1200);
          },
        );
        await this.done(dest, kind.toUpperCase());
        return;
      }
      default:
        break;
    }

    // Text exports work from the parsed model.
    const c = await this.provider.compute(target.uri, {}, cfg);
    const view = { sortKeys: cfg.sortKeys, maskKeys: cfg.maskKeys };
    let text: string;
    let ext: string;
    let label: string;
    switch (kind) {
      case 'json':
        text = exportJson(c.parsed, view);
        ext = 'json';
        label = 'JSON';
        break;
      case 'resolvedYaml':
        text = exportResolvedYaml(c.parsed, view);
        ext = 'resolved.yaml';
        label = 'Resolved YAML';
        break;
      default:
        text = exportMarkdown(c.parsed, { ...view, title: baseName(target.uri) });
        ext = 'md';
        label = 'Markdown';
    }
    const dest = await this.save(target.uri, `${name}.${ext}`, { [label]: [ext.split('.').pop() as string] });
    if (!dest) {
      return;
    }
    await this.write(dest, text);
    await this.done(dest, label);
  }

  /** Copy every document as JSON or resolved YAML. */
  async copy(kind: 'json' | 'resolvedYaml', explicit?: vscode.Uri): Promise<void> {
    const target = this.resolveTarget(explicit);
    if (!target) {
      return;
    }
    const c = await this.provider.compute(target.uri);
    const view = { sortKeys: c.cfg.sortKeys, maskKeys: c.cfg.maskKeys };
    const text = kind === 'json' ? exportJson(c.parsed, view) : exportResolvedYaml(c.parsed, view);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`YAML Preview: copied as ${kind === 'json' ? 'JSON' : 'resolved YAML'}`, 2500);
  }

  async saveDiagramSvg(hash: string): Promise<void> {
    const d = this.provider.diagramBySource(hash);
    if (!d?.result?.svg) {
      void vscode.window.showWarningMessage('YAML Preview: this diagram has not been rendered.');
      return;
    }
    const dest = await vscode.window.showSaveDialog({ filters: { SVG: ['svg'] }, saveLabel: 'Save diagram' });
    if (dest) {
      await this.write(dest, d.result.svg);
      await this.done(dest, 'Diagram');
    }
  }

  static readonly KINDS: Array<{ label: string; kind: ExportKind; desktopOnly?: boolean; description: string }> = [
    { label: 'HTML', kind: 'html', description: 'Self-contained, interactive page (diagrams embedded)' },
    { label: 'PDF', kind: 'pdf', desktopOnly: true, description: 'Print-ready, via Chrome' },
    { label: 'PNG', kind: 'png', desktopOnly: true, description: 'Full-page image, via Chrome' },
    { label: 'JPEG', kind: 'jpeg', desktopOnly: true, description: 'Full-page image, via Chrome' },
    { label: 'JSON', kind: 'json', description: 'Anchors and merge keys resolved' },
    { label: 'Resolved YAML', kind: 'resolvedYaml', description: 'Anchors, aliases and merge keys expanded' },
    { label: 'Markdown', kind: 'markdown', description: 'Headings, lists and tables' },
    { label: 'Open in browser', kind: 'browser', desktopOnly: true, description: 'Opens a temporary HTML file' },
  ];
}

export { SECTION };
