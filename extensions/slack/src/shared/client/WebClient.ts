import { environment, getPreferenceValues, LocalStorage, OAuth } from "@raycast/api";
import { OAuthService } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import { LogLevel, WebClient, type WebClientOptions } from "@slack/web-api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { createCanvasClient } from "./canvas";
import { slackRetryConfig } from "./retryPolicy";
import { type Workspace, workspaceStore } from "./workspaces";
export type { SlackConversation, SlackMember } from "./slackTypes";

async function withAccountLock<T>(operation: () => Promise<T>) {
  await mkdir(environment.supportPath, { recursive: true });
  const release = await lock(environment.supportPath, {
    lockfilePath: join(environment.supportPath, "accounts.lock"),
    retries: { retries: 12, minTimeout: 25, maxTimeout: 300 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function nativeTokens(registration: string) {
  return new OAuth.PKCEClient(oauthOptions(registration)).getTokens();
}

export const accounts = workspaceStore(LocalStorage, withAccountLock, async (registration) => {
  const tokens = await nativeTokens(registration);
  if (!tokens?.accessToken) return "missing";
  return tokens.isExpired() ? "expired" : "connected";
});

export function getProxyAgent() {
  const { proxyUrl } = getPreferenceValues<Preferences>();
  const url = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  return url ? new HttpsProxyAgent(url) : undefined;
}

function createClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, {
    agent: getProxyAgent(),
    retryConfig: slackRetryConfig(),
    logLevel: LogLevel.ERROR,
    ...options,
  });
}

export function addWorkspace(token: string) {
  return accounts.add(token, (value) => createClient(value).auth.test());
}

function oauthOptions(registration: string) {
  return {
    providerId: "slack-workspace-" + registration,
    providerName: "Slack",
    providerIcon: "slack-icon-rounded.png",
    description: "Choose a Slack workspace to connect to Raycast.",
    redirectMethod: OAuth.RedirectMethod.Web,
  };
}

// Keep the new grant in memory until auth.test has identified its owner.
class WorkspaceLogin extends OAuth.PKCEClient {
  private grant?: OAuth.TokenSetOptions | OAuth.TokenResponse;
  async setTokens(grant: OAuth.TokenSetOptions | OAuth.TokenResponse) {
    this.grant = grant;
  }
  saveGrant() {
    if (!this.grant) throw new Error("Slack did not return a new grant.");
    return super.setTokens(this.grant);
  }
}

export async function connectWorkspace() {
  const registration = randomUUID();
  const service = OAuthService.slack({
    scope:
      "users:read users:read.email channels:read groups:read im:read mpim:read chat:write channels:history groups:history im:history mpim:history channels:write groups:write im:write mpim:write users:write dnd:read dnd:write search:read users.profile:write emoji:read users.profile:read files:read files:write reactions:write canvases:read canvases:write",
  });
  // The built-in Slack service supplies Raycast's OAuth proxy, client ID and user-token parser.
  // Isolate the native credential before authorization, while Slack's selected team is still unknown.
  const login = new WorkspaceLogin(oauthOptions(registration));
  service.client = login;
  const token = await service.authorize();
  const identity = await createClient(token).auth.test();
  return accounts.addOAuth(identity, registration, () => login.saveGrant());
}

async function workspaceToken(workspace: Workspace) {
  const record = await accounts.credential(workspace);
  if ("token" in record) return record.token;
  const tokens = await nativeTokens(record.registration);
  if (!tokens?.accessToken || tokens.isExpired())
    throw new Error("Sign-in expired for " + record.teamName + ". Remove and reconnect it in Manage Workspaces.");
  return tokens.accessToken;
}

export function removeWorkspace(workspace: Workspace) {
  return accounts.remove(workspace, async (record) => {
    if ("auth" in record) await new OAuth.PKCEClient(oauthOptions(record.registration)).removeTokens();
  });
}

function createSession(workspace: Workspace, token: string) {
  // The SDK invokes this on each HTTP attempt, including queued requests and retries.
  const requestInterceptor: NonNullable<WebClientOptions["requestInterceptor"]> = async (config) => {
    if ((await workspaceToken(workspace)) !== token) throw new Error("Slack sign-in changed. Reopen this command.");
    return config;
  };
  return {
    workspace,
    client: createClient(token, { teamId: workspace.teamId, requestInterceptor }),
    // Background ordering must never pause an interactive write behind Slack's rate-limit retry queue.
    activityClient: (signal?: AbortSignal) =>
      createClient(token, {
        teamId: workspace.teamId,
        requestInterceptor: async (config) => {
          const authorized = await requestInterceptor(config);
          signal?.throwIfAborted();
          if (signal) authorized.signal = signal;
          return authorized;
        },
        timeout: 6000,
        rejectRateLimitedCalls: true,
        retryConfig: { retries: 0 },
      }),
    canvas: createCanvasClient(token, getProxyAgent(), requestInterceptor),
  };
}
type Session = ReturnType<typeof createSession>;
const clients = new Map<string, Session>();
const current = new AsyncLocalStorage<Session>();

export async function inWorkspace<T>(workspace: Workspace, operation: () => T): Promise<Awaited<T>> {
  const token = await workspaceToken(workspace);
  let session = clients.get(workspace.teamId);
  if (!session || session.workspace.registration !== workspace.registration || session.client.token !== token) {
    session = createSession(workspace, token);
    clients.set(workspace.teamId, session);
  }
  return await current.run(session, operation);
}

function active() {
  const session = current.getStore();
  if (!session) throw new Error("Choose a Slack workspace.");
  return session;
}
export const getSlackWebClient = () => active().client;
export const getActivityClient = (signal?: AbortSignal) => active().activityClient(signal);
export const getCanvasWebClient = () => active().canvas;
export const getSlackToken = () => workspaceToken(active().workspace);
export const getWorkspace = () => active().workspace;
