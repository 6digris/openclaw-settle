import process from "node:process";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runUtf8CommandWithTimeout } from "./exec.js";

it("attaches private control before admitting input and replies to the exact child", async () => {
  const events: string[] = [];
  const child = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      "-e",
      `
    process.stdin.resume();
    process.stdin.once('data', () => process.send({kind:'ready'}));
    process.once('message', reply => { process.stdout.write(JSON.stringify(reply)); process.disconnect(); });
  `,
    ],
    {
      timeoutMs: 10_000,
      input: "private input",
      beforeInput: () => {
        events.push("admitted");
      },
      onChildMessage: async (message, reply) => {
        expect(message).toEqual({ kind: "ready" });
        events.push("request");
        await reply({ kind: "released" });
      },
      killProcessTree: true,
      requireProcessTreeExtinction: true,
    },
  );
  expect(child).toMatchObject({ code: 0, cleanup: "normal" });
  expect(JSON.parse(child.stdout)).toEqual({ kind: "released" });
  expect(events).toEqual(["admitted", "request"]);
});

it("preserves a control failure and settles the spawned process", async () => {
  const failed = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      "-e",
      `
    process.send('request'); setInterval(()=>{},1000);
  `,
    ],
    {
      timeoutMs: 10_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killGraceMs: 100,
      onChildMessage: async () => {
        throw new Error("authority revoked");
      },
    },
  ).catch((error: unknown) => error);
  expect(failed).toMatchObject({ message: "authority revoked" });
});

it("joins entered control work after child disconnect instead of publishing early completion", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const complete = vi.fn();
  const running = runUtf8CommandWithTimeout(
    [
      process.execPath,
      "-e",
      `
    process.send('request',()=>process.disconnect());
  `,
    ],
    {
      timeoutMs: 10_000,
      onChildMessage: async (_message, reply) => {
        entered.resolve();
        await release.promise;
        await reply("ack");
      },
    },
  ).then(complete, (error: unknown) => error);
  await entered.promise;
  try {
    expect(complete).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  expect(await running).toMatchObject({
    message: expect.stringMatching(/Command control channel disconnected|write EPIPE/),
  });
  expect(complete).not.toHaveBeenCalled();
});

it("settles a timed-out child which never completes the private handshake", async () => {
  const result = await runUtf8CommandWithTimeout(
    [
      process.execPath,
      "-e",
      `
    process.send('request'); setInterval(()=>{},1000);
  `,
    ],
    {
      timeoutMs: 300,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killGraceMs: 100,
      onChildMessage: async () => {},
    },
  );
  expect(result.termination).toBe("timeout");
  expect(result.code).not.toBe(0);
});
