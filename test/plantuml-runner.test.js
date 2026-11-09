const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PlantUmlRunner } = require('../out/plantuml-runner');
const E = require('../out/engine');

const JAR = process.env.PLANTUML_JAR || '/usr/local/bin/plantuml.jar';
const haveJava = (() => { try { execFileSync('java', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const haveJar = fs.existsSync(JAR);
const real = haveJava && haveJar;

const settings = (over = {}) => ({ jarPath: JAR, javaPath: 'java', securityProfile: 'SANDBOX', timeoutMs: 30000, extraArgs: [], ...over });
/**
 * Is `pid` still executing? A killed orphan can linger as a zombie ("Z") when
 * PID 1 does not reap children (common in containers); that process is dead.
 */
function isRunning(pid) {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^\d+ \(.*\) /, '')[0];
    return state !== 'Z' && state !== 'X';
  } catch { return true; } // no /proc (macOS): kill(pid, 0) succeeding means alive
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ype-'));
const script = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return f; };

suite('plantuml-runner (real jar)', function () {
  this.timeout(60000);
  suiteSetup(function () { if (!real) { console.log(`      (skipped: need java and ${JAR})`); this.skip(); } });

  const fixture = E.parseYaml(fs.readFileSync(path.join(__dirname, 'fixtures', 'requirements.yaml'), 'utf8'));
  const diagram = E.renderPreview(fixture, { ...E.DEFAULT_RENDER_OPTIONS, views: ['document'] }).diagrams[0].source;

  test('renders the requirements fixture diagram from the YAML end-to-end', async () => {
    const r = await new PlantUmlRunner().render(diagram, settings());
    assert.ok(r.svg, r.error);
    assert.strictEqual(r.warning, undefined);
    assert.ok(E.looksLikeSvg(r.svg));
    assert.match(r.svg, /data-diagram-type="SEQUENCE"/);
    for (const text of ['Web App', 'Auth Service', 'session token', 'show dashboard']) {
      assert.ok(r.svg.includes(text), `diagram should contain "${text}"`);
    }
    // the same result must produce a page-ready figure
    const html = E.diagramInnerHtml(r, diagram);
    assert.match(html, /<img class="uml-img"[^>]*src="data:image\/svg\+xml;base64,/);
  });

  test('a syntax error still yields PlantUML’s error picture, flagged with a message', async () => {
    const r = await new PlantUmlRunner().render('@startuml\nAlice -> \nfoo bar baz\n@enduml', settings());
    assert.ok(r.svg, 'error picture is returned');
    assert.match(r.warning, /error on diagram line 2/i);
    assert.match(E.diagramInnerHtml(r, 'x'), /uml-note sev-warning/);
  });

  test('other diagram kinds render (mindmap, gantt, json)', async () => {
    const run = new PlantUmlRunner();
    for (const [src, type] of [['@startmindmap\n* a\n** b\n@endmindmap', 'MINDMAP'], ['@startgantt\n[T] lasts 3 days\n@endgantt', 'GANTT'], ['@startjson\n{"a":[1,2]}\n@endjson', 'JSON']]) {
      const r = await run.render(src, settings());
      assert.match(r.svg, new RegExp(`data-diagram-type="${type}"`), src);
    }
  });

  test('non-ASCII text survives the round trip', async () => {
    const r = await new PlantUmlRunner().render('@startuml\nA -> B: héllo wörld → 日本語\n@enduml', settings());
    assert.ok(r.svg.includes('héllo wörld') && r.svg.includes('日本語'));
  });

  test('results are cached: the second render spawns nothing', async () => {
    const run = new PlantUmlRunner();
    const a = await run.render('@startuml\nA -> B: cache\n@enduml', settings());
    const t = Date.now();
    const b = await run.render('@startuml\nA -> B: cache\n@enduml', settings());
    assert.strictEqual(a, b);
    assert.strictEqual(run.stats.spawned, 1);
    assert.strictEqual(run.stats.cacheHits, 1);
    assert.ok(Date.now() - t < 200, 'cache hit is instant');
    // a different security profile is a different cache entry
    await run.render('@startuml\nA -> B: cache\n@enduml', settings({ securityProfile: 'INTERNET' }));
    assert.strictEqual(run.stats.spawned, 2);
  });

  test('identical concurrent requests share one JVM', async () => {
    const run = new PlantUmlRunner();
    const src = '@startuml\nA -> B: once\n@enduml';
    const rs = await Promise.all([1, 2, 3, 4].map(() => run.render(src, settings())));
    assert.ok(rs.every((r) => r === rs[0]));
    assert.strictEqual(run.stats.spawned, 1);
  });

  test('SANDBOX stops a diagram from reading local files', async () => {
    const secret = path.join(tmp, 'secret.txt');
    fs.writeFileSync(secret, 'TOP-SECRET-CONTENT');
    const src = `@startuml\n!include ${secret}\nA -> B\n@enduml`;
    const safe = await new PlantUmlRunner().render(src, settings({ securityProfile: 'SANDBOX' }));
    assert.ok(!(safe.svg || '').includes('TOP-SECRET-CONTENT'), 'SANDBOX must not leak the file');
    const legacy = await new PlantUmlRunner().render(src, settings({ securityProfile: 'LEGACY' }));
    assert.ok((legacy.svg || '').includes('TOP-SECRET-CONTENT'), 'sanity: LEGACY does read it, so the env var is really applied');
  });

  test('the bundled standard library works inside SANDBOX', async () => {
    const r = await new PlantUmlRunner().render('@startuml\n!include <C4/C4_Container>\nPerson(u, "User")\nSystem(s, "Sys")\nRel(u, s, "uses")\n@enduml', settings());
    assert.match(r.svg || r.error, /data-diagram-type="DESCRIPTION"/);
  });

  test('a shell-metacharacter-laden diagram cannot inject commands', async () => {
    const marker = path.join(tmp, 'pwned');
    const src = `@startuml\nA -> B: $(touch ${marker}) ; \`touch ${marker}\` | touch ${marker}\n@enduml`;
    const r = await new PlantUmlRunner().render(src, settings());
    assert.ok(r.svg);
    assert.ok(!fs.existsSync(marker), 'no shell is involved');
  });

  test('probe reports the PlantUML version', async () => {
    const p = await new PlantUmlRunner().probe(settings());
    assert.ok(p.ok, p.message);
    assert.match(p.message, /PlantUML version/);
  });
});

suite('plantuml-runner (failure handling)', function () {
  this.timeout(30000);
  const SRC = '@startuml\nA -> B\n@enduml';
  // The jar is only stat()ed for these, so any existing file will do.
  const dummyJar = path.join(tmp, 'dummy.jar');
  suiteSetup(() => fs.writeFileSync(dummyJar, 'x'));

  test('a missing jar gives an actionable message and is not cached', async () => {
    const run = new PlantUmlRunner();
    const r = await run.render(SRC, settings({ jarPath: '/nonexistent/plantuml.jar' }));
    assert.match(r.error, /PlantUML jar not found at "\/nonexistent\/plantuml\.jar".*plantumlJarPath/);
    assert.strictEqual(run.stats.spawned, 0);
  });

  test('a directory is not accepted as the jar', async () => {
    assert.match((await new PlantUmlRunner().render(SRC, settings({ jarPath: tmp }))).error, /not found/);
  });

  test('missing Java gives an actionable message', async () => {
    const r = await new PlantUmlRunner().render(SRC, settings({ jarPath: dummyJar, javaPath: '/nonexistent/java' }));
    assert.match(r.error, /Java not found.*javaPath/);
    const p = await new PlantUmlRunner().probe(settings({ jarPath: dummyJar, javaPath: '/nonexistent/java' }));
    assert.strictEqual(p.ok, false);
    assert.match(p.message, /Java not found/);
  });

  test('a hung process is killed after the timeout', async () => {
    const hang = script('hang.sh', 'sleep 30');
    const t = Date.now();
    const r = await new PlantUmlRunner().render(SRC, settings({ jarPath: dummyJar, javaPath: hang, timeoutMs: 400 }));
    assert.match(r.error, /did not finish within 0\.4 s/);
    assert.ok(Date.now() - t < 3000, 'returned promptly');
  });

  test('the whole process tree is killed, including a grandchild JVM behind a wrapper script', async () => {
    const pidfile = path.join(tmp, 'grandchild.pid');
    // The wrapper starts a long-running grandchild, like `java` behind a shim.
    const wrapper = script('wrapper.sh', `sleep 60 &\necho $! > ${pidfile}\nwait`);
    const r = await new PlantUmlRunner().render(SRC, settings({ jarPath: dummyJar, javaPath: wrapper, timeoutMs: 400 }));
    assert.match(r.error, /did not finish/);
    await new Promise((res) => setTimeout(res, 300));
    const pid = Number(fs.readFileSync(pidfile, 'utf8').trim());
    assert.strictEqual(isRunning(pid), false, `grandchild ${pid} must not survive the timeout`);
  });

  test('dispose() stops running processes', async () => {
    const run = new PlantUmlRunner();
    const hang = script('hang2.sh', 'sleep 30');
    const p = run.render(SRC, settings({ jarPath: dummyJar, javaPath: hang, timeoutMs: 20000 }));
    await new Promise((res) => setTimeout(res, 300));
    run.dispose();
    const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('still running'), 1500))]);
    // dispose() kills the tree; the promise settles via the close handler
    assert.notStrictEqual(r, 'still running');
  });

  test('garbage output is rejected, not embedded', async () => {
    const bad = script('bad.sh', "cat >/dev/null; printf '<html><script>alert(1)</script></html>'");
    const r = await new PlantUmlRunner().render(SRC, settings({ jarPath: dummyJar, javaPath: bad }));
    assert.strictEqual(r.svg, undefined);
    assert.match(r.error, /no image/);
  });

  test('stderr from a failing process is surfaced', async () => {
    const fail = script('fail.sh', "cat >/dev/null; echo 'Error: Unable to access jarfile' >&2; exit 1");
    const r = await new PlantUmlRunner().render(SRC, settings({ jarPath: dummyJar, javaPath: fail }));
    assert.match(r.error, /Unable to access jarfile/);
  });

  test('errors are not cached, so a fix takes effect immediately', async () => {
    const run = new PlantUmlRunner();
    const marker = path.join(tmp, 'flip');
    const flaky = script('flaky.sh', `cat >/dev/null\nif [ -f ${marker} ]; then printf '<svg xmlns="http://www.w3.org/2000/svg"/>'; else echo broken >&2; exit 1; fi`);
    const s = settings({ jarPath: dummyJar, javaPath: flaky });
    assert.ok((await run.render(SRC, s)).error);
    fs.writeFileSync(marker, '1');
    assert.ok((await run.render(SRC, s)).svg);
  });

  test('at most maxConcurrent JVMs run at once', async () => {
    const log = path.join(tmp, 'conc.log');
    const slow = script('slow.sh', `echo start >> ${log}\nsleep 0.4\necho end >> ${log}\ncat >/dev/null\nprintf '<svg xmlns="http://www.w3.org/2000/svg"/>'`);
    const run = new PlantUmlRunner(2);
    const s = settings({ jarPath: dummyJar, javaPath: slow });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => run.render(`@startuml\nA -> B: ${i}\n@enduml`, s)));
    assert.ok(rs.every((r) => r.svg));
    let cur = 0, max = 0;
    for (const l of fs.readFileSync(log, 'utf8').trim().split('\n')) { cur += l === 'start' ? 1 : -1; max = Math.max(max, cur); }
    assert.strictEqual(max, 2);
    assert.strictEqual(run.stats.spawned, 6);
  });

  test('oversized sources are refused without spawning', async () => {
    const run = new PlantUmlRunner();
    const r = await run.render('x'.repeat(300000), settings({ jarPath: dummyJar }));
    assert.match(r.error, /too large/);
    assert.strictEqual(run.stats.spawned, 0);
  });

  test('the cache is bounded (LRU)', async () => {
    const ok = script('ok.sh', "cat >/dev/null; printf '<svg xmlns=\"http://www.w3.org/2000/svg\"/>'");
    const run = new PlantUmlRunner(3, 2);
    const s = settings({ jarPath: dummyJar, javaPath: ok });
    for (const n of ['a', 'b', 'c']) await run.render(`@startuml\n${n}\n@enduml`, s);
    await run.render('@startuml\nc\n@enduml', s); // still cached
    assert.strictEqual(run.stats.cacheHits, 1);
    await run.render('@startuml\na\n@enduml', s); // evicted → respawn
    assert.strictEqual(run.stats.spawned, 4);
  });
});
