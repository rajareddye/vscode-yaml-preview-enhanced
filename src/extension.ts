import type * as vscode from 'vscode';
import { exportWithChrome } from './chrome-export';
import { readConfig } from './config';
import { NativeCustomization, writeTempHtml } from './customization';
import { NativeDiagramService } from './diagram-service';
import { activateCommon } from './extension-common';
import type { Platform } from './platform';

/** Desktop extension host (Node): local Java, Chrome and the filesystem. */
export function activate(context: vscode.ExtensionContext): void {
  const platform: Platform = {
    isWeb: false,
    diagrams: new NativeDiagramService(),
    customization: new NativeCustomization(() => readConfig()),
    nativeExport: {
      writeTempHtml,
      exportWithChrome: (html, kind, outPath, cfg, width) =>
        exportWithChrome(
          html,
          { kind, outPath },
          {
            chromePath: cfg.chromePath,
            extraArgs: cfg.chromeArgs,
            printBackground: cfg.printBackground,
            width,
          },
        ),
    },
  };
  activateCommon(context, platform);
}

export function deactivate(): void {
  /* subscriptions dispose everything, including running PlantUML processes */
}
