/**
 * `shutdown` hook — stop ingress and release in-process state.
 *
 * Runs on assistant teardown, uninstall, disable, and in-place reload.
 *
 * `ShutdownContext` carries no logger, so this hook is deliberately silent.
 *
 * The poll cursor is durable and deliberately left on disk: it is what stops
 * the next boot from either replaying the backlog or skipping whatever arrived
 * while the daemon was down.
 */

import type { ShutdownContext } from "@vellumai/plugin-api";

import { stopIngress } from "../src/channel-runtime.ts";
import { getProvider, resetPluginState } from "../src/plugin-state.ts";

const shutdown = async (_ctx: ShutdownContext): Promise<void> => {
  await stopIngress();
  await getProvider()
    ?.close?.()
    .catch(() => {});
  resetPluginState();
};

export default shutdown;
