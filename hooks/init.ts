/**
 * `init` hook — plugin bootstrap.
 *
 * Validates config, stashes the context the runtime needs, and starts the
 * channel. The actual work lives in `src/channel-runtime.ts` so that a
 * settings save from the configuration app runs the identical code path.
 *
 * Nothing here touches credentials. The provider resolves what it needs at
 * call time, so an unconfigured line — the normal state between install and
 * setup — costs nothing at boot.
 */

import type { InitContext } from "@vellumai/plugin-api";

import { startChannelRuntime } from "../src/channel-runtime.ts";
import { resolveConfig } from "../src/config.ts";
import { setInitContext } from "../src/plugin-state.ts";
import { pluginName } from "../src/plugin-paths.ts";

const init = async (ctx: InitContext): Promise<void> => {
  const { config, warnings } = resolveConfig(ctx.config);
  for (const warning of warnings) {
    ctx.logger.warn({ warning }, `sms config: ${warning}`);
  }

  setInitContext({
    logger: ctx.logger,
    pluginStorageDir: ctx.pluginStorageDir,
    pluginName: pluginName(),
  });

  const { status, idleReason } = await startChannelRuntime(config);
  if (status === "idle") {
    ctx.logger.info(
      { idleReason },
      "sms: channel is idle — fix the configuration or add credentials in the settings app",
    );
  }
};

export default init;
