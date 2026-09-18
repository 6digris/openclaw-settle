import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { spawnNodeEvalSync } from "../../test-utils/node-process.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "spawn broker caller working directory",
  () => {
    it.each([undefined, "relative"])("resolves cwd %s in the caller's current directory", (cwd) => {
      const directory = path.join(tempDirs.make("openclaw-broker-cwd-"), "changed");
      mkdirSync(directory);
      const expected = cwd ? path.join(directory, cwd) : directory;
      if (cwd) {
        mkdirSync(expected);
      }
      const result = spawnNodeEvalSync(
        `
        import {once} from 'node:events';
        import {createSpawnBrokerHost} from ${JSON.stringify(new URL("./host.ts", import.meta.url).href)};
        import {runWithSpawnBroker} from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};
        import {spawnProcess} from ${JSON.stringify(new URL("../spawn-utils.ts", import.meta.url).href)};
        import {runExec} from ${JSON.stringify(new URL("../exec.ts", import.meta.url).href)};
        const host = createSpawnBrokerHost();
        await host.ready();
        try {
          process.chdir(${JSON.stringify(directory)});
          await runWithSpawnBroker(host, async () => {
            const args = ['-e','process.stdout.write(process.cwd())'];
            const cwd = ${JSON.stringify(cwd)};
            const child = spawnProcess(process.execPath, args, {cwd,stdio:['ignore','pipe','ignore']});
            await once(child,'spawn');
            let native = '';
            child.stdout.on('data', chunk => native += chunk);
            await once(child,'close');
            const command = await runExec(process.execPath,args,{cwd,logOutput:false});
            console.log(JSON.stringify({native, command:command.stdout}));
          });
        } finally { await host.close(); }
        `,
        { imports: ["tsx"], timeout: 15_000, maxBuffer: 64 * 1024 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ native: expected, command: expected });
    });
  },
);
