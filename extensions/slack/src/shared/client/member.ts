import type { SlackMember } from "./slackTypes";

export function toUserName(member: SlackMember): readonly [username: string, displayName: string] | undefined {
  const { id, name: username } = member;
  if (!id || member.is_bot || member.is_workflow_bot || member.deleted || id === "USLACKBOT") return undefined;

  const displayName = memberDisplayName(member);

  if (!displayName || !username) return undefined;

  return [username, displayName];
}

/** DMs may point to bots or deactivated members that are excluded from the people picker. */
export function memberDisplayName(member: SlackMember) {
  const { profile } = member;
  const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(" ");
  return [fullName, profile?.display_name, profile?.real_name, member.real_name, member.name]
    .map((value) => value?.trim())
    .find((value) => value && value !== member.id);
}
