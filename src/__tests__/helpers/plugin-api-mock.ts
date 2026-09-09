/**
 * The one `@vellumai/plugin-api` mock for the whole suite.
 *
 * Bun runs every test file in a single process, and a `mock.module`
 * registered by an earlier file can win over one registered later. So every
 * file that mocks the plugin-api must register the *same* factory from this
 * module — whichever registration applies, the behavior is identical.
 *
 * `runConversationTurn` does not exist in the published plugin-api (the
 * channel-binding signature is still host-side, per `run-turn.ts`), so the
 * mock is also what makes that import link at all.
 */

/** Credential values the mock resolves, keyed `"service/field"`. */
export const credentialValues: Record<string, string> = {
  "sms/account_sid": "AC0123456789",
  "sms/auth_token": "tok-1",
  "sms/from_number": "+15559998888",
};

/** The turns `runConversationTurn` was called with. */
export const turns: Record<string, unknown>[] = [];

/** What `runConversationTurn` resolves with. Tests replace this. */
export let turnResult: Record<string, unknown> = {
  conversationId: "conv-1",
  content: [{ type: "text", text: "hi back" }],
};

/** Replace what `runConversationTurn` resolves with. */
export function setTurnResult(next: Record<string, unknown>): void {
  turnResult = next;
}

/** Clear the shared state. Call from `beforeEach` in tests that read it. */
export function resetSharedState(): void {
  turns.length = 0;
  turnResult = {
    conversationId: "conv-1",
    content: [{ type: "text", text: "hi back" }],
  };
}

/** The mock factory every plugin-api-mocking test registers. */
export function pluginApiMock(): Record<string, unknown> {
  return {
    runConversationTurn: (options: Record<string, unknown>) => {
      turns.push(options);
      return Promise.resolve(turnResult);
    },
    resolveCredential: (ref: string) => {
      const value = credentialValues[ref];
      return value
        ? Promise.resolve(value)
        : Promise.reject(new Error(`unresolved credential: ${ref}`));
    },
    getWorkspaceDir: () => "/tmp",
  };
}
