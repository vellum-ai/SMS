/** `GET /x/plugins/sms/settings`: current SMS setup status. */

import { handleSettingsGet } from "../src/app-routes.ts";

export async function GET(_request: Request): Promise<Response> {
  return handleSettingsGet();
}
