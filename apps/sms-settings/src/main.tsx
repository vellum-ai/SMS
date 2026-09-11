/**
 * SMS settings app.
 *
 * A compiled React app served in the workspace panel. Requests go through the
 * host bridge in `api.ts`, never the bare global `fetch`.
 */

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiRequest, messageOf } from "./api.ts";

const BASE = "/x/plugins/sms";

const PROVIDER_CATALOG = {
  id: "twilio",
  subtitle:
    "Your own Twilio account and number. One auth token covers sending, receiving, and webhook signing.",
  credentialsGuide: {
    description:
      "Sign in to the Twilio Console and copy the live Account SID and Auth Token from the dashboard, plus a number on the account that can send SMS. Trial accounts can only text numbers verified in the console.",
    url: "https://console.twilio.com",
    linkLabel: "Open Twilio Console",
  },
} as const;

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .app { max-width: 640px; margin: 0 auto; padding: 24px 20px 64px; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 12px;
    padding: 20px;
  }
  .card h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .card .subtitle {
    margin: 4px 0 0;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .divider {
    border: 0;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    margin: 16px 0;
  }
  .stack { display: grid; gap: 16px; }
  .field { display: grid; gap: 4px; }
  .field > label {
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .field .note {
    margin: 0;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .field input {
    font: inherit;
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    background: color-mix(in srgb, CanvasText 4%, Canvas);
    color: CanvasText;
  }
  .field input:disabled { opacity: 0.6; }
  .guide {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    background: color-mix(in srgb, CanvasText 5%, transparent);
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 65%, transparent);
  }
  .guide .icon { flex: none; margin-top: 1px; }
  .guide .body { display: flex; flex-direction: column; gap: 4px; }
  .guide a {
    display: inline-flex; align-items: center; gap: 4px;
    color: AccentColor; text-decoration: underline;
  }
  .guide a:hover { opacity: 0.8; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit; font-size: 14px; padding: 7px 14px;
    border-radius: 8px; cursor: pointer;
  }
  button.save {
    font-weight: 600; color: Canvas; background: AccentColor;
    border: 1px solid AccentColor;
  }
  button.save:disabled { opacity: 0.45; cursor: default; }
  button.reset {
    background: transparent; border: 1px solid transparent;
    color: color-mix(in srgb, CanvasText 45%, red);
  }
  button.reset:hover { background: color-mix(in srgb, red 10%, transparent); }
  .banner {
    border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 13px;
    overflow-wrap: anywhere;
  }
  .banner.err {
    background: color-mix(in srgb, Canvas 82%, red);
    color: color-mix(in srgb, CanvasText 35%, red);
    border: 1px solid color-mix(in srgb, CanvasText 25%, red);
  }
  .banner.info { background: color-mix(in srgb, CanvasText 8%, transparent); }
`;

interface CredentialField {
  field: string;
  label: string;
  placeholder: string;
  secret: boolean;
  set: boolean;
}

type Credentials = Record<string, CredentialField[]>;
type ChannelStatus = "running" | "idle";

interface WebhookReport {
  provider: string;
  outcome: "registered" | "already-registered" | "skipped" | "failed";
  url?: string;
  step?: "resolve-url" | "call-provider";
  reason?: string;
  at: string;
}

interface Settings {
  activeProvider: string | null;
  credentials: Credentials;
  webhook: WebhookReport | null;
}

interface ChannelResult {
  status?: ChannelStatus | null;
  idleReason?: string | null;
}

interface Notice {
  tone: "info" | "err";
  text: string;
}

function noticeFor(result: ChannelResult, what: string): Notice {
  if (result.status === "idle") {
    return {
      tone: "err",
      text: `${what} The channel is not running: ${
        result.idleReason ?? "no reason given"
      }`,
    };
  }
  return {
    tone: "info",
    text: result.status === "running" ? `${what} The channel is running.` : what,
  };
}

function describeWebhook(report: WebhookReport | null): string {
  if (!report) {
    return "No webhook registration has been attempted since this plugin loaded.";
  }
  switch (report.outcome) {
    case "registered":
      return `Programmed the number's SMS webhook at ${report.url}.`;
    case "already-registered":
      return `The number's SMS webhook already points here (${report.url}).`;
    case "skipped":
      return `Not registered: ${report.reason ?? "no reason given"}`;
    case "failed":
      return `Webhook registration failed${
        report.step ? ` (${report.step})` : ""
      }: ${report.reason ?? "no reason given"}`;
  }
}

function InfoIcon(): React.ReactElement {
  return (
    <svg
      className="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}

function ExternalLinkIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  );
}

function App(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<Settings>("Loading settings", `${BASE}/settings`);
      setSettings(next);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fields: CredentialField[] =
    settings?.credentials[PROVIDER_CATALOG.id] ?? [];

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);

    const values = Object.fromEntries(
      fields
        .map((spec): [string, string] => [spec.field, drafts[spec.field] ?? ""])
        .filter(([, value]) => value.trim().length > 0),
    );

    try {
      const result = await apiRequest<ChannelResult>(
        "Saving credentials",
        `${BASE}/credentials`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: PROVIDER_CATALOG.id, values }),
        },
      );
      setDrafts({});
      setNotice(noticeFor(result, "Saved."));
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }, [drafts, fields, load, settings]);

  const reset = useCallback(() => {
    setDrafts({});
    setNotice(null);
  }, []);

  if (error && !settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <div className="banner err">{error}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  const typed = fields.some(
    (spec) => (drafts[spec.field] ?? "").trim().length > 0,
  );
  const webhookNote = describeWebhook(settings.webhook);

  return (
    <div className="app">
      <style>{STYLES}</style>
      <section className="card">
        <h1>SMS</h1>
        <p className="subtitle">
          People reach the assistant by texting a Twilio line it listens on.
        </p>
        <hr className="divider" />

        {error ? <div className="banner err">{error}</div> : null}
        {notice ? <div className={`banner ${notice.tone}`}>{notice.text}</div> : null}
        <div className="stack">
          <div className="field">
            <label>Provider</label>
            <p className="note">{PROVIDER_CATALOG.subtitle}</p>
          </div>

          {fields.map((spec) => (
            <div className="field" key={spec.field}>
              <label htmlFor={spec.field}>{spec.label}</label>
              <input
                id={spec.field}
                type={spec.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  spec.set
                    ? "••••••••  (Enter a new value to replace)"
                    : spec.placeholder
                }
                value={drafts[spec.field] ?? ""}
                disabled={saving}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [spec.field]: event.target.value,
                  }))
                }
              />
            </div>
          ))}

          <div className="guide">
            <InfoIcon />
            <div className="body">
              <span>{PROVIDER_CATALOG.credentialsGuide.description}</span>
              <a
                href={PROVIDER_CATALOG.credentialsGuide.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {PROVIDER_CATALOG.credentialsGuide.linkLabel}
                <ExternalLinkIcon />
              </a>
            </div>
          </div>

          <div className="field">
            <label>Inbound messages</label>
            <p className="note">
              Twilio delivers inbound messages to this plugin over a webhook.
              The assistant must have a public ingress URL.
            </p>
            {settings.webhook?.outcome === "failed" ? (
              <div className="banner err">{webhookNote}</div>
            ) : (
              <p className="note">{webhookNote}</p>
            )}
          </div>

          <div className="actions">
            <button
              type="button"
              className="save"
              disabled={!typed || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {typed ? (
              <button
                type="button"
                className="reset"
                disabled={saving}
                onClick={reset}
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
