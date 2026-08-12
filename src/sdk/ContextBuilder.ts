import type { RunFlowContext } from '../types/SDKTypes';

/** Chainable handle returned by `ContextBuilder(...)` - see that function's doc. */
export interface ContextBuilderHandle {
  useAgent(agentId: string): ContextBuilderHandle;
  useWorkspace(workspaceId: string): ContextBuilderHandle;
  /** Reuse an existing session/thread instead of starting a new, invisible one. */
  useSession(sessionId: string): ContextBuilderHandle;
  useProject(projectId: string): ContextBuilderHandle;
  useAttachments(attachments: any[]): ContextBuilderHandle;
  build(): RunFlowContext;
}

/**
 * Chainable builder for `agent.runFlow`'s `context` param - the explicit identity a flow runs as
 * (agent/workspace/session/project/attachments). Exists because `agent.runFlow` deliberately does
 * NOT infer any of this from the live invocation automatically beyond a bare agent/workspace
 * fallback (see `RunFlowContext`'s doc) - building the object by hand works too, this just reads
 * better at the call site:
 *
 *   await agent.runFlow(flow, {
 *     context: ContextBuilder().useAgent(agentId).useSession(sessionId).build(),
 *   });
 *
 * Called as a plain function (`ContextBuilder(base?)`, no `new`) - it returns a fresh chainable
 * handle each time, nothing here is sent anywhere until `.build()` produces the plain object.
 */
export function ContextBuilder(base?: RunFlowContext): ContextBuilderHandle {
  const ctx: RunFlowContext = { ...base };
  const handle: ContextBuilderHandle = {
    useAgent(agentId) {
      ctx.agent_id = agentId;
      return handle;
    },
    useWorkspace(workspaceId) {
      ctx.workspace_id = workspaceId;
      return handle;
    },
    useSession(sessionId) {
      ctx.session_id = sessionId;
      return handle;
    },
    useProject(projectId) {
      ctx.project_id = projectId;
      return handle;
    },
    useAttachments(attachments) {
      ctx.attachments = attachments;
      return handle;
    },
    build() {
      return { ...ctx };
    },
  };
  return handle;
}
