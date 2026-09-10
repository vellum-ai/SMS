/**
 * `shutdown` hook: release the active provider and reset in-process state.
 *
 * Runs on assistant teardown, uninstall, disable, and in-place reload.
 * `ShutdownContext` carries no logger, so this hook is deliberately silent.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { getProvider, resetPluginState } from "../src/plugin-state.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  await getProvider()
    ?.close?.()
    .catch(() => {});
  resetPluginState();
};

export default shutdown;
