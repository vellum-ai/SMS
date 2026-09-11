/** Request handlers backing the plugin's HTTP routes (`routes/*.ts`). */

import { z } from "zod";

import {
  CredentialWriteError,
  readCredentialStatus,
  storeCredentials,
} from "./app-credentials.ts";
import { readConfigView } from "./app-settings.ts";
import { startChannelRuntime } from "./channel-runtime.ts";
import { getProvider, getWebhookReport } from "./plugin-state.ts";
import { pluginConfigPath } from "./plugin-paths.ts";
import { PROVIDER_IDS, unavailableProviderList } from "./providers/types.ts";

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

/** `GET /x/plugins/sms/settings`: credentials and webhook setup status. */
export async function handleSettingsGet(): Promise<Response> {
  const config = readConfigView(pluginConfigPath());
  return json({
    config,
    providers: PROVIDER_IDS,
    unavailableProviders: unavailableProviderList(),
    activeProvider: getProvider()?.id ?? null,
    credentials: await readCredentialStatus(),
    webhook: getWebhookReport() ?? null,
  });
}

/**
 * `POST /x/plugins/sms/credentials`: store Twilio credentials and program the
 * configured number's webhook before reporting success.
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
        detail: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  try {
    await storeCredentials(parsed.data.provider, parsed.data.values);
  } catch (err) {
    if (err instanceof CredentialWriteError) return json({ error: err.message }, 400);
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
