import type { Customization } from './platform';

/** Web: no filesystem to read customisation from. */
export class WebCustomization implements Customization {
  async loadCss(): Promise<string> {
    return '';
  }
  async loadHead(): Promise<string> {
    return '';
  }
  async loadConfigOverrides(): Promise<unknown> {
    return {};
  }
  async loadParserHooks(): Promise<[]> {
    return [];
  }
  async openFile(): Promise<void> {
    throw new Error('Customisation files are not available in the web version.');
  }
}
