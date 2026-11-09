import type { DiagramResult } from './engine';
import type { DiagramService } from './platform';

const MESSAGE =
  'PlantUML diagrams need the desktop version of VS Code with Java installed (the web extension cannot run a local jar).';

/** Web: there is no process to spawn, so say so instead of failing silently. */
export class WebDiagramService implements DiagramService {
  async render(): Promise<DiagramResult> {
    return { error: MESSAGE };
  }
  clear(): void {}
  async probe() {
    return { ok: false, message: MESSAGE };
  }
  dispose(): void {}
}
