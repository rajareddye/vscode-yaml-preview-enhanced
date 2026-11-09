import type { DiagramResult } from './engine';
import type { DiagramService } from './platform';
import { PlantUmlRunner, PlantUmlSettings } from './plantuml-runner';

/** Desktop: local `java -jar plantuml.jar`. */
export class NativeDiagramService implements DiagramService {
  private readonly runner = new PlantUmlRunner();
  render(source: string, settings: PlantUmlSettings): Promise<DiagramResult> {
    return this.runner.render(source, settings);
  }
  clear(): void {
    this.runner.clear();
  }
  probe(settings: PlantUmlSettings) {
    return this.runner.probe(settings);
  }
  dispose(): void {
    this.runner.dispose();
  }
}
