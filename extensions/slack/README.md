# Slack for Raycast

Open a channel, search messages, choose a recipient, or read followed conversations across your Slack workspaces. Each row shows its workspace. The workspace dropdown starts on **All Workspaces** and remembers your choice for each command.

## Install locally

This fork keeps the original extension directory and commit history so you can merge future Raycast changes. It uses the original **Slack** command identity and **@slack** alias. Uninstall the Store version before importing this fork. Original extension by **mommertf** and the upstream contributors. [Upstream source](https://github.com/raycast/extensions/tree/main/extensions/slack) · [MIT license](../../LICENSE)

```sh
git clone --filter=blob:none --sparse https://github.com/alvarogar4/raycast-slack-multi.git
cd raycast-slack-multi
git sparse-checkout set extensions/slack
cd extensions/slack
npm ci
npm run dev
```

Run **Connect with Slack** in Raycast, or open the [command link](raycast://extensions/mommertf/slack/connect-workspace). Choose **Sign in with Slack**, select a workspace in the browser, and click **Allow**. Slack returns you to Raycast. Run the command again for each additional workspace. Each workspace has its own Raycast OAuth login. Open **Manage Workspaces** to rename or remove a connection. If Slack expires or revokes a grant, remove that connection and run **Connect with Slack** again.

**Open Channel** lists available public channels, private channels you belong to, group conversations, and DMs, excluding archived conversations. Public channels you can browse before joining carry a **Not joined** label. **Join Channel** explicitly joins one. **Send Message** lets you pick a recipient from any connected workspace, then shows the recipient and workspace in the composer. [Slack conversation listing](https://docs.slack.dev/reference/methods/conversations.list/)

**Open Channel**, **Send Message**, and **Unread Messages** mix conversations from the selected workspaces by latest received message. Conversations with no known message date appear after dated conversations. For large workspaces, reopening the directory checks more history. Use **Actions → Sort Conversations** to switch to alphabetical order. **Add to Favorites** pins a conversation above the other results in all three commands. App and bot DMs are hidden from the directory by default. Use **Show App Conversations** to include them.

**Search Messages** mixes matches from the selected workspaces, newest first. Opening a match takes you to that message in Slack when the app is installed. Use **Sort by → Most Relevant** to rank by relevance. **From** and **Search in This Channel** narrow the search to the selected message’s workspace.

**Open Unread Messages** asks for a workspace, then opens Unreads in the installed Slack app. If Slack’s native navigation is unavailable, the command opens the workspace and shows its keyboard shortcut. With no Slack app installed, it opens that workspace’s Unreads page in your browser. In Raycast’s **Unread Messages**, use **Configure** on each workspace to select up to 30 conversations to follow. **Set Status**, **Set Presence**, and **Set Snooze** let you choose one workspace or apply the change to all. AI tools accept a workspace ID or unique workspace name. Include it when sending a message, replying to a thread, or uploading a file.

## Opening channels and direct messages

The **Open Links In** extension preference defaults to **Automatic**, which uses the Slack app when detected. If channels open in your browser despite Slack being installed, choose **Slack App**. Choose **Browser** to always use the web client. Native links use the system's registered `slack://` handler, so Slack must be installed to use **Slack App**.

## Search emojis

In the **Search Emojis** command preferences, set **Emoji Sort Order** to **Most Used**, **Alphabetical**, or **Slack's Original Order**. **Most Used** is the default and ranks emojis copied or pasted through Raycast, with usage saved per workspace on your machine. Usage in Slack itself does not count. Use **Reset Ranking** on an emoji in **Most Used** order to return it to its original position.

## Missing Slack permissions

If your workspace requires app approval, request approval from your Slack administrator. If you use your own Slack app, add the missing user scopes, reinstall it, and replace its token in **Manage Workspaces**.

## Set your status from a deep link

The **Set Status** command accepts optional arguments, `statusText` and `emoji`, so you can build a deep link (or a [Quicklink](https://manual.raycast.com/quicklinks)) that sets your status in one step:

```
raycast://extensions/mommertf/slack/set-status?arguments=%7B%22statusText%22%3A%22Lunch%22%2C%22emoji%22%3A%22%3Ahamburger%3A%22%7D
```

The `arguments` query parameter is a URL-encoded JSON object, for example:

```json
{ "statusText": "Lunch", "emoji": ":hamburger:" }
```

- Either argument may be omitted; only the one you provide is changed.
- `emoji` accepts a Slack emoji name with or without colons (`hamburger` or `:hamburger:`).

Statuses set without an expiration stay until cleared. To pick an expiration, open the command and use the **Set New Status** form.

## Optional setup with your own Slack app

Use **Manage Workspaces → Add with User Token** if you prefer to use your own Slack app. Repeat these steps in each workspace where you want to use it. If your workspace requires app approval, ask its administrator to approve the installation.

1. Open [Your Apps](https://api.slack.com/apps/).
2. Click Button `Create New App`
3. Select `From an app manifest`
4. Select a workspace to which you want to grant the extension access.
5. Copy and paste the following manifest (Select `YAML`):
   _Feel free to exclude permission scope groups - see comments - if you don't want to have the full experience of this extension._

   ```
   display_information:
     name: Raycast - Slack

   oauth_config:
     scopes:
       user:
         # Command: Search & Unread Messages & Set Presence
         - users:read
         - users:read.email

         # Command: Search & Unread Messages
         - channels:read
         - groups:read
         - im:read
         - mpim:read

         # Command: Search
         - search:read

         # Command: Unread Messages
         - channels:history
         - groups:history
         - im:history
         - mpim:history

         # Command: Unread Messages (optional - needed for marking conversations as read)
         - channels:write
         - groups:write

         # Command: Unread Messages (optional - needed for marking conversations as read)
         # AI Tool: Send Message (needed to open a DM from a user ID)
         - im:write
         - mpim:write

         # Command: Set Presence
         - users:write

         # Command: Set Snooze
         - dnd:read
         - dnd:write

         # Command & AI Tool: Send Message
         - chat:write

         # AI Tool: Upload Files
         - files:write

         # AI Tool: Download Files
         # Command: Search Messages (Download Attachment)
         - files:read

         # Command: Search Emojis
         - emoji:read

         # AI Tool: Add Reaction
         - reactions:write

         # AI Tools: Read Canvas & Edit Canvas
         - canvases:read
         - canvases:write

         # Command: Set Status
         - users.profile:write
         - users.profile:read

   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

6. Confirm creation of app
7. Press `Install to Workspace`
8. Get your personal access token from `Features -> OAuth & Permissions` (section `OAuth Tokens for Your Workspace`).
   Choose the **User OAuth Token** beginning with `xoxp-`. Paste it into **Manage Workspaces → Add with User Token**.

## Proxy Support

If you are behind a corporate proxy, you can configure the extension to route Slack API requests through it.

### Configuration

The proxy URL is resolved in the following order:

1. **Raycast preference** — set the "Proxy URL" field in the extension settings (e.g. `http://proxy.example.com:8080`)
2. **`HTTPS_PROXY` environment variable**
3. **`HTTP_PROXY` environment variable**

## Slack API rate limits

Slack applies Web API rate limits **per API method, per workspace, per app**, using one-minute windows. The published tier number is a guaranteed floor rather than a fixed maximum; Slack allows some bursts and may change the exact allowance. Signing in again or clearing Raycast's extension cache does not reset these workspace-level app limits.

The limits most relevant to this extension are:

| Extension operation                     | Slack method                                                                         | Published limit                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Search workspace members                | [`users.list`](https://docs.slack.dev/reference/methods/users.list/)                 | Tier 2: 20+ requests per minute                                                  |
| Search channels and group conversations | [`conversations.list`](https://docs.slack.dev/reference/methods/conversations.list/) | Tier 2: 20+ requests per minute                                                  |
| Search messages                         | [`search.messages`](https://docs.slack.dev/reference/methods/search.messages/)       | Tier 2: 20+ requests per minute                                                  |
| Send messages                           | [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/)     | Special: generally 1 message per second per channel, plus a workspace-wide limit |

`users.list` and `conversations.list` are cursor-paginated, and every page is another request against that method's rate limit. Directory loading and search use Slack's recommended 200-item page size. User search scans `users.list` once, keeping a compact copy of the member list in memory and in Raycast's `Cache` (fresh for one hour, reusable for up to a day while it refreshes in the background), so later searches make no member requests. Pages are searched as they arrive, so matches appear without waiting for the whole workspace. Timeouts and server errors stop retrying after a few attempts so they surface instead of loading forever.

When a limit is exceeded, Slack responds with HTTP `429` and a `Retry-After` header containing the number of seconds to wait. The extension waits and retries automatically without showing a toast, including during AI tool calls, except for Canvas tools, which return the wait time without retrying. Although Slack applies limits per method, the Slack SDK pauses this client's request queue during the retry delay. See [Slack's rate-limit overview](https://docs.slack.dev/apis/web-api/rate-limits/) for the full tier definitions and current policy.
