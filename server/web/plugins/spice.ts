// ngspice in the plugin's frame: the circuit simulator behind the `ngspice` program and the libngspice stand-in of
// the Python runtime (plugins/python/kicad_spice.py).  The simulator is the real ngspice, compiled to WebAssembly
// (npm eecircuit-engine); it runs as the interactive program does, reading one command after another.  This file
// gives that a session: run some commands and get what ngspice printed, and reach its files.
//
// The package's Simulation class is made for one fixed command list ("source, run, write").  A session swaps that
// list for its own each time and is told when ngspice has read the last of it and waits for more.

export interface SpiceResult { out: string; err: string[] }
export interface SpiceSession {
  exec(commands: string[]): Promise<SpiceResult>;
  write(path: string, data: Uint8Array | string): void;
  read(path: string): Uint8Array | null;
  list(dir: string): string[];
  remove(path: string): void;
  version: string;
}

/** ngspice's own chatter about every start: not errors, and not for the console. */
const quietly = async <T,>(job: () => Promise<T>): Promise<T> => {
  const real = console.error; console.error = () => undefined;
  try { return await job(); } finally { console.error = real; }
};

export async function open(url: string): Promise<SpiceSession> {
  const mod: any = await import(url);
  const sim: any = new mod.Simulation();
  let done: (() => void) | null = null;
  // ngspice asks for its next command list here: the one it had is finished
  sim.waitForNextRun = () => { const d = done; done = null; if (d) d(); return new Promise<void>((go) => { sim.continuePromiseResolve = go; }); };
  await quietly(() => sim.start());
  const fs: any = sim.__getSpiceModuleForTests().FS;
  const version = (/ngspice-([\w.]+)/.exec(String(sim.getInitInfo())) || ["", ""])[1];
  let busy: Promise<unknown> = Promise.resolve();
  const exec = (commands: string[]): Promise<SpiceResult> => {
    const turn = busy.then(() => quietly(async () => {
      sim.info = ""; sim.error = [];
      sim.commandList = [" ", ...commands.map((c) => (c === "source test.cir" ? "source ./test.cir" : c))];
      const finished = new Promise<void>((ok) => { done = ok; });
      sim.continueRun();
      await finished;
      return { out: String(sim.info), err: (sim.error as string[]).slice() };
    }));
    busy = turn.catch(() => undefined);
    return turn;
  };
  return {
    exec, version,
    write(path, data) { const dir = path.slice(0, path.lastIndexOf("/")); if (dir) fs.mkdirTree(dir); fs.writeFile(path, data); },
    read(path) { try { return fs.readFile(path) as Uint8Array; } catch { return null; } },
    list(dir) { try { return (fs.readdir(dir) as string[]).filter((n) => n !== "." && n !== ".."); } catch { return []; } },
    remove(path) { try { fs.unlink(path); } catch { /* not there */ } },
  };
}

(globalThis as any).__kcSpice = { open };
