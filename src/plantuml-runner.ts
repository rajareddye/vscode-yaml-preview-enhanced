import { ChildProcess, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import {
  DiagramResult,
  describePlantUmlStderr,
  looksLikeSvg,
} from './engine/plantuml';

/**
 * Runs the local PlantUML jar (`java -jar plantuml.jar -pipe -tsvg`).
 *
 * Deliberately free of any `vscode` import so it can be unit-tested against a
 * real jar. Guarantees:
 *   - never throws: failures come back as `{ error }`;
 *   - no shell is involved (arguments are passed as an array);
 *   - one JVM at a time per diagram, a bounded number in parallel;
 *   - results are cached (LRU) and identical in-flight requests are shared;
 *   - runaway processes are killed (timeout, output size cap).
 */

export interface PlantUmlSettings {
  jarPath: string;
  javaPath: string;
  /** SANDBOX | INTERNET | LEGACY | UNSECURE … (`PLANTUML_SECURITY_PROFILE`). */
  securityProfile: string;
  timeoutMs: number;
  /** Extra PlantUML arguments, e.g. `['-theme', 'cerulean']`. */
  extraArgs: string[];
}

/**
 * Kill a child *and its descendants*. `java` is often reached through a
 * wrapper script (SDKMAN, Homebrew shims, …); killing only the wrapper would
 * leave the real JVM running and holding our pipes open.
 */
function killTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL'); // the child leads its own group
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function formatSeconds(ms: number): string {
  return ms >= 10000 ? `${Math.round(ms / 1000)}` : `${+(ms / 1000).toFixed(1)}`;
}

const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_SOURCE_CHARS = 256 * 1024;

export class PlantUmlRunner {
  /** Counters, exposed for tests and diagnostics. */
  readonly stats = { spawned: 0, cacheHits: 0 };

  private readonly cache = new Map<string, DiagramResult>();
  private readonly inflight = new Map<string, Promise<DiagramResult>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private readonly children = new Set<ChildProcess>();

  constructor(
    private readonly maxConcurrent = 3,
    private readonly cacheSize = 200,
  ) {}

  clear(): void {
    this.cache.clear();
  }

  /** Stop every running PlantUML process (extension shutdown). */
  dispose(): void {
    this.queue.length = 0;
    for (const c of this.children) {
      killTree(c);
    }
    this.children.clear();
  }

  async render(
    source: string,
    settings: PlantUmlSettings,
  ): Promise<DiagramResult> {
    if (source.length > MAX_SOURCE_CHARS) {
      return { error: 'The diagram source is too large to render.' };
    }
    let stamp: string;
    try {
      const st = await fsp.stat(settings.jarPath);
      if (!st.isFile()) {
        throw new Error('not a file');
      }
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      return {
        error: `PlantUML jar not found at "${settings.jarPath}". Set "yaml-preview-enhanced.plantumlJarPath" to your plantuml.jar.`,
      };
    }

    const key = JSON.stringify([
      stamp,
      settings.jarPath,
      settings.javaPath,
      settings.securityProfile,
      settings.extraArgs,
      source,
    ]);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      this.stats.cacheHits++;
      return hit;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }

    const p = this.schedule(() => this.run(source, settings))
      .then((result) => {
        // Only cache real images: configuration errors (no Java, bad path)
        // must be retried once the user fixes them.
        if (result.svg) {
          this.cache.set(key, result);
          while (this.cache.size > this.cacheSize) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
        }
        return result;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** `java -jar plantuml.jar -version`, for the "Test PlantUML" command. */
  probe(settings: PlantUmlSettings): Promise<{ ok: boolean; message: string }> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          settings.javaPath,
          ['-Djava.awt.headless=true', '-jar', settings.jarPath, '-version'],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
      } catch (e) {
        return resolve({ ok: false, message: String(e) });
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          message:
            e.code === 'ENOENT'
              ? `Java not found ("${settings.javaPath}"). Install a JRE or set "yaml-preview-enhanced.javaPath".`
              : `Could not start Java: ${e.message}`,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const first = (out || err).split(/\r?\n/).find((l) => l.trim());
        resolve(
          code === 0 && first
            ? { ok: true, message: first.trim() }
            : {
                ok: false,
                message: `PlantUML did not start (exit ${code}): ${(err || out).trim().split('\n')[0] || 'no output'}`,
              },
        );
      });
    });
  }

  /* -------------------------------------------------------------- */

  private schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < this.maxConcurrent) {
        start();
      } else {
        this.queue.push(start);
      }
    });
  }

  private run(source: string, s: PlantUmlSettings): Promise<DiagramResult> {
    this.stats.spawned++;
    return new Promise((resolve) => {
      const args = [
        '-Djava.awt.headless=true',
        '-Dfile.encoding=UTF-8',
        // Default is 4096px, which silently crops large sequence diagrams.
        '-DPLANTUML_LIMIT_SIZE=16384',
        '-jar',
        s.jarPath,
        '-pipe',
        '-tsvg',
        '-charset',
        'UTF-8',
        ...s.extraArgs,
      ];
      let child;
      try {
        child = spawn(s.javaPath, args, {
          env: { ...process.env, PLANTUML_SECURITY_PROFILE: s.securityProfile },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group on POSIX so killTree() can take the whole tree.
          detached: process.platform !== 'win32',
        });
      } catch (e) {
        return resolve({ error: `Could not start Java: ${String(e)}` });
      }
      this.children.add(child);

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let timedOut = false;
      let tooBig = false;
      let done = false;
      const finish = (r: DiagramResult) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          this.children.delete(child);
          resolve(r);
        }
      };
      // Do not wait for 'close' after a kill: a surviving grandchild could
      // keep the pipes open indefinitely.
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        finish({
          error: `PlantUML did not finish within ${formatSeconds(s.timeoutMs)} s and was stopped.`,
        });
      }, s.timeoutMs);

      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes > MAX_OUTPUT_BYTES) {
          tooBig = true;
          killTree(child);
          finish({ error: 'PlantUML produced an unreasonably large image.' });
        } else {
          out.push(c);
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        if (errBytes < MAX_STDERR_BYTES) {
          errBytes += c.length;
          err.push(c);
        }
      });
      child.stdin.on('error', () => {
        /* the process exited before reading everything (EPIPE) */
      });
      child.on('error', (e: NodeJS.ErrnoException) =>
        finish({
          error:
            e.code === 'ENOENT'
              ? `Java not found ("${s.javaPath}"). Install a JRE or set "yaml-preview-enhanced.javaPath".`
              : `Could not start Java: ${e.message}`,
        }),
      );
      child.on('close', (code) => {
        if (timedOut || tooBig) {
          return; // already reported
        }
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (looksLikeSvg(stdout)) {
          // Syntax errors exit with 200 but still emit an error picture that
          // pinpoints the problem — show it, flagged with the message.
          return finish({
            svg: stdout,
            warning:
              code === 0
                ? undefined
                : (describePlantUmlStderr(stderr) ??
                  `PlantUML exited with code ${code}.`),
          });
        }
        finish({
          error:
            describePlantUmlStderr(stderr) ??
            `PlantUML produced no image (exit code ${code}).`,
        });
      });
      child.stdin.end(source, 'utf8');
    });
  }
}
