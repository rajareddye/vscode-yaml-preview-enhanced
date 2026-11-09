import { existsSync, promises as fsp } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import puppeteer from 'puppeteer-core';

/**
 * PDF / PNG / JPEG export through a locally installed Chrome, Chromium or Edge
 * (driven over the DevTools protocol by puppeteer-core — nothing to download).
 *
 * Free of any `vscode` import so it can be tested against a real browser.
 */

export interface ChromeOptions {
  /** Empty → auto-detect. */
  chromePath: string;
  /** Extra flags, e.g. `['--no-sandbox']` inside containers. */
  extraArgs: string[];
  timeoutMs?: number;
  /** Include background colours/images in PDFs. */
  printBackground?: boolean;
  /** Viewport width used for layout (and therefore for PNG/JPEG width). */
  width?: number;
  /** Internal: some headless-only builds need `'shell'`. */
  headless?: boolean | 'shell';
}

export type ChromeTarget = {
  kind: 'pdf' | 'png' | 'jpeg';
  outPath: string;
};

/** Common install locations, in preference order. */
export function chromeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (env.CHROME_PATH) {
    out.push(env.CHROME_PATH);
  }
  if (platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else if (platform === 'win32') {
    const roots = [
      env['PROGRAMFILES'],
      env['PROGRAMFILES(X86)'],
      env['LOCALAPPDATA'],
    ].filter(Boolean) as string[];
    for (const r of roots) {
      out.push(
        join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(r, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
  } else {
    out.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/snap/bin/chromium',
      '/usr/local/bin/chromium',
      join(homedir(), '.local', 'bin', 'chromium'),
    );
  }
  return out;
}

export function findChrome(configured: string): string | undefined {
  if (configured.trim()) {
    return existsSync(configured) ? configured : undefined;
  }
  return chromeCandidates().find((p) => existsSync(p));
}

/** `file:///C:/x/y.html` on Windows, `file:///tmp/y.html` elsewhere. */
export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, '/');
  return `file://${p.startsWith('/') ? '' : '/'}${encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export async function exportWithChrome(
  html: string,
  target: ChromeTarget,
  opts: ChromeOptions,
): Promise<void> {
  const chrome = findChrome(opts.chromePath);
  if (!chrome) {
    throw new Error(
      opts.chromePath.trim()
        ? `Chrome was not found at "${opts.chromePath}". Fix "yaml-preview-enhanced.chromePath".`
        : 'No Chrome, Chromium or Edge installation was found. Install one, or set "yaml-preview-enhanced.chromePath".',
    );
  }
  const timeout = opts.timeoutMs ?? 60000;
  const dir = await fsp.mkdtemp(join(tmpdir(), 'yaml-preview-'));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    const htmlPath = join(dir, 'export.html');
    await fsp.writeFile(htmlPath, html, 'utf8');

    try {
      browser = await puppeteer.launch({
        executablePath: chrome,
        headless: opts.headless ?? true,
        // Never touch the user's real Chrome profile.
        userDataDir: join(dir, 'profile'),
        args: ['--hide-scrollbars', '--disable-extensions', ...opts.extraArgs],
        timeout,
      });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e))
        .split('\n')
        .find((l) => l.trim()) ?? 'unknown error';
      const hint = /sandbox/i.test(String(e))
        ? ' (inside a container, add "--no-sandbox" to "yaml-preview-enhanced.chromeArgs")'
        : '';
      throw new Error(`Could not start Chrome: ${msg}${hint}`);
    }

    const page = await browser.newPage();
    await page.setViewport({ width: opts.width ?? 1200, height: 900 });
    await page.goto(fileUrl(htmlPath), { waitUntil: 'load', timeout });
    // The page script fills in diagrams; wait for their images to decode.
    await page.evaluate(() =>
      Promise.all(
        Array.from(document.images).map((img) =>
          img.decode ? img.decode().catch(() => undefined) : undefined,
        ),
      ),
    );

    if (target.kind === 'pdf') {
      await page.pdf({
        path: target.outPath,
        format: 'A4',
        printBackground: opts.printBackground ?? false,
        margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
      });
    } else {
      await page.screenshot({
        path: target.outPath as `${string}.png`,
        type: target.kind,
        fullPage: true,
        ...(target.kind === 'jpeg' ? { quality: 90 } : {}),
      });
    }
    if (!existsSync(target.outPath)) {
      throw new Error('Chrome finished but did not write the output file.');
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
