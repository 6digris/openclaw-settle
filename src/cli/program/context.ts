// Root program context: version plus lazily computed channel option strings for help text.
import { VERSION } from "../../version.js";
import { resolveCliChannelOptions } from "../channel-options.js";

/** Root CLI program context consumed by command registration and help rendering. */
export type ProgramContext = {
  activateDoctorCapture?: () => Promise<void>;
  programVersion: string;
  messageChannelOptions: string;
  agentChannelOptions: string;
};

/** Create a program context that resolves channel options once on first use. */
export function createProgramContext(
  prepared: Pick<ProgramContext, "activateDoctorCapture"> = {},
): ProgramContext {
  let cachedChannelOptions: string[] | undefined;
  const getChannelOptions = (): string[] => {
    if (cachedChannelOptions === undefined) {
      cachedChannelOptions = resolveCliChannelOptions();
    }
    return cachedChannelOptions;
  };

  return {
    ...prepared,
    programVersion: VERSION,
    get messageChannelOptions() {
      return getChannelOptions().join("|");
    },
    get agentChannelOptions() {
      return ["last", ...getChannelOptions()].join("|");
    },
  };
}
