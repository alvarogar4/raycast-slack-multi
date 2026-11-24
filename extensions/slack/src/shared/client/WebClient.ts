import { environment, getPreferenceValues, LocalStorage } from "@raycast/api";
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

export const accounts = workspaceStore(LocalStorage, async (operation) => {
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

function createSession(workspace: Workspace, token: string) {
  // The SDK invokes this on each HTTP attempt, including queued requests and retries.
  const requestInterceptor: NonNullable<WebClientOptions["requestInterceptor"]> = async (config) => {
    await accounts.credential(workspace);
    return config;
  };
  return {
    workspace,
    client: createClient(token, { teamId: workspace.teamId, requestInterceptor }),
    canvas: createCanvasClient(token, getProxyAgent(), requestInterceptor),
  };
}
type Session = ReturnType<typeof createSession>;
const clients = new Map<string, Session>();
const current = new AsyncLocalStorage<Session>();

export async function inWorkspace<T>(workspace: Workspace, operation: () => T): Promise<Awaited<T>> {
  const { token } = await accounts.credential(workspace);
  let session = clients.get(workspace.teamId);
  if (!session || session.workspace.registration !== workspace.registration) {
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
export const getCanvasWebClient = () => active().canvas;
export const getSlackToken = async () => (await accounts.credential(active().workspace)).token;
export const getWorkspace = () => active().workspace;
