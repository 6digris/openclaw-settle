import { EventEmitter } from "node:events";
import { vi } from "vitest";

export type FakeProc = EventEmitter & {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: (sig?: string) => boolean;
  stderr: EventEmitter;
};

export function makeFakeProc(overrides: Partial<FakeProc> = {}): FakeProc {
  const stderr = new EventEmitter();
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((sig = "SIGTERM") => {
      proc.killed = true;
      proc.signalCode = sig as NodeJS.Signals;
      proc.emit("exit", null, sig);
      return true;
    }),
    stderr,
  }) as unknown as FakeProc;
  return Object.assign(proc, overrides);
}

export function makeFailedSpawnProc(error: NodeJS.ErrnoException): FakeProc {
  const proc = makeFakeProc({ pid: undefined });
  queueMicrotask(() => proc.emit("error", error));
  return proc;
}
