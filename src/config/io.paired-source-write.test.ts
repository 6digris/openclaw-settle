import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("paired source through the public config writer", () => {
  it.each([false, true])(
    "retains authored identity after read-time environment drift (include=%s)",
    async (include) => {
      await withTempHome(async (home) => {
        const browser = { enabled: true, executablePath: "${CONFIG_PAIRED_BROWSER}" };
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          agents: { entries: { main: { name: "/opt/browser-before" } } },
          browser: include ? { $include: "./browser.json" } : browser,
        });
        const includePath = path.join(path.dirname(configPath), "browser.json");
        if (include) {
          await fs.writeFile(includePath, JSON.stringify(browser) + "\n");
        }
        const rootBefore = await fs.readFile(configPath, "utf8");
        const ownedPath = include ? includePath : configPath;
        const ownedBefore = await fs.readFile(ownedPath, "utf8");
        const env = {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          CONFIG_PAIRED_BROWSER: "/opt/browser-before",
        };
        const io = createConfigIO({ env, configPath, homedir: () => home });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({
          observe: false,
        });
        expect(snapshot.valid).toBe(true);
        expect(snapshot.authoredConfig?.browser?.executablePath).toBe("${CONFIG_PAIRED_BROWSER}");
        expect(snapshot.sourceConfig.browser?.executablePath).toBe("/opt/browser-before");
        io.env.CONFIG_PAIRED_BROWSER = "/opt/browser-after";
        await replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          sourceConfig: {
            ...snapshot.sourceConfig,
            browser: { ...snapshot.sourceConfig.browser, enabled: false },
          },
          writeOptions: { ...writeOptions, observe: false },
          io,
        });
        const saved = JSON.parse(await fs.readFile(ownedPath, "utf8"));
        expect(include ? saved : saved.browser).toMatchObject({
          enabled: false,
          executablePath: "${CONFIG_PAIRED_BROWSER}",
        });
        expect(await fs.readFile(ownedPath + ".bak", "utf8")).toBe(ownedBefore);
        const reloaded = await io.readConfigFileSnapshot({ observe: false });
        expect(reloaded.sourceConfig.browser?.executablePath).toBe("/opt/browser-after");
        expect(reloaded.sourceConfig.agents?.entries?.main?.name).toBe("/opt/browser-before");
        if (include) {
          expect(await fs.readFile(configPath, "utf8")).toBe(rootBefore);
        }
      });
    },
  );
});
