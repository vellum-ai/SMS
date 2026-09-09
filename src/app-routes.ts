/**
 * Request handlers backing the plugin's HTTP routes (`routes/*.ts`).
 *
 * The route files are thin wrappers that call these. Each handler resolves the
 * plugin's own paths internally, so callers never pass a directory in.
 *
 * There is no provider-switch handler: Twilio is the only implementation.
 */

import { z } from "zod";

import {
  CredentialWriteError,
  readCredentialStatus,
  storeCredentials,
} from "./app-credentials.ts";
import {
  applyConfigUpdate,
  ConfigUpdateSchema,
  ConfigValidationError,
  mergeConfigUpdate,
  readConfigView,
} from "./app-settings.ts";
import { startChannelRuntime } from "./channel-runtime.ts";
import { INGRESS_MODES } from "./config.ts";
import { getProvider, getWebhookReport } from "./plugin-state.ts";
import { pluginConfigPath } from "./plugin-paths.ts";
import { PROVIDER_IDS, unavailableProviderList } from "./providers/types.ts";

/**
 * The body the credentials route accepts.
 *
 * `values` is an open record rather than a fixed shape: which fields the
 * provider takes lives in `PROVIDER_CREDENTIALS`, and validating it twice
 * means one of the copies is eventually wrong. `storeCredentials` rejects a
 * field the provider does not have.
 */
const CredentialUpdateSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    values: z.record(z.string(), z.string()),
  })
  .strict();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * `GET /x/plugins/sms/settings`: the resolved config plus what the app needs
 * to render its controls.
 *
 * `activeProvider` is the provider actually running, which can differ from the
 * configured one when the configured provider failed to build. Reporting both
 * is what lets the app show "configured as twilio, currently idle" instead of
 * claiming everything is fine.
 *
 * `credentials` rides along rather than sitting behind its own GET: the app
 * needs it to draw the very first frame, and a second round trip would only
 * buy a moment of rendering fields whose state is unknown.
 *
 * `providers` and `ingressModes` are what the plugin actually supports; the
 * app holds only the copy describing them, and renders the intersection.
 */
export async function handleSettingsGet(): Promise<Response> {
  const config = readConfigView(pluginConfigPath());
  return json({
    config,
    providers: PROVIDER_IDS,
    unavailableProviders: unavailableProviderList(),
    ingressModes: INGRESS_MODES,
    activeProvider: getProvider()?.id ?? null,
    credentials: await readCredentialStatus(),
    // What the last registration attempt in this process did. Registration
    // runs un-awaited and used to report itself only through the logger, so
    // "no webhook exists and nothing says why" was reachable. This is the
    // answer without needing the daemon's log.
    webhook: getWebhookReport() ?? null,
  });
}

/**
 * `POST /x/plugins/sms/credentials`: store the provider's credentials.
 *
 * Answers with the refreshed status rather than an acknowledgement, so the app
 * renders what the store actually holds instead of assuming the write landed.
 *
 * Storing credentials also restarts ingress. A channel that is idle for want
 * of an auth token should come up the moment the token arrives, and telling
 * someone to go click a save button afterwards is a step that only exists
 * because the code did not do it.
 */
export async function handleCredentialsPost(
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = CredentialUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: "invalid credential update",
        detail: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  try {
    await storeCredentials(parsed.data.provider, parsed.data.values);
  } catch (err) {
    if (err instanceof CredentialWriteError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  const config = readConfigView(pluginConfigPath());
  const result =
    config.provider === parsed.data.provider
      ? await startChannelRuntime(config, { waitForSetup: true })
      : undefined;

  if (result?.status === "idle") {
    return json(
      { error: result.idleReason ?? "Could not start the channel." },
      400,
    );
  }

  return json({
    credentials: await readCredentialStatus(),
    status: result?.status ?? null,
    idleReason: result?.idleReason ?? null,
    activeProvider: getProvider()?.id ?? null,
  });
}

/** `PATCH /x/plugins/sms/settings`: apply a partial update. */
export async function handleSettingsPatch(
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const parsed = ConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error: "invalid settings update",
        detail: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      400,
    );
  }

  let next;
  try {
    next = mergeConfigUpdate(pluginConfigPath(), parsed.data);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return json({ error: err.message }, 400);
    }
    throw err;
  }

  const previous = readConfigView(pluginConfigPath());
  // Ingress settings change how inbound is received. Start the new mode
  // before writing so a credential that cannot resolve fails the save
  // instead of leaving the file on a mode the channel cannot use.
  const result = await startChannelRuntime(next, { waitForSetup: true });
  if (result.status === "idle") {
    await startChannelRuntime(previous);
    return json(
      { error: result.idleReason ?? "Could not apply settings." },
      400,
    );
  }

  applyConfigUpdate(pluginConfigPath(), parsed.data);
  return json({
    config: readConfigView(pluginConfigPath()),
    status: result.status,
    activeProvider: getProvider()?.id ?? null,
  });
}
