type Application = { name: string; bundleId?: string; path: string };

export function isSlackApplication(app: Application): boolean {
  return (
    app.bundleId === "com.tinyspeck.slackmacgap" ||
    /^slack(?:\.exe| beta)?$/i.test(app.name) ||
    /(?:^|[/\\])slack(?: beta)?\.(?:app|exe)$/i.test(app.path)
  );
}

export type SlackLinkPreference = "auto" | "slack" | "browser";

export async function shouldOpenInSlack(
  preference: SlackLinkPreference,
  getApplications: () => Promise<Application[]>,
): Promise<boolean> {
  if (preference !== "auto") return preference === "slack";
  try {
    return (await getApplications()).some(isSlackApplication);
  } catch {
    // App enumeration can fail even when the slack:// protocol handler is registered.
    return true;
  }
}

export function nativeMessageLink(teamId: string, timestamp: string, channelId?: string, permalink?: string) {
  const link = permalink && URL.canParse(permalink) ? new URL(permalink) : undefined;
  const channel = channelId || link?.pathname.match(/^\/archives\/([CDG][A-Z0-9]+)\//)?.[1];
  if (!channel) return undefined;
  const params = new URLSearchParams({ team: teamId, id: channel, message: timestamp });
  const thread = link?.searchParams.get("thread_ts");
  if (thread) params.set("thread_ts", thread);
  return "slack://channel?" + params;
}
