import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

export const environment = {
  assetsPath: join(process.cwd(), "assets"),
  supportPath: mkdtempSync(join(tmpdir(), "slack-multi-test-")),
};
const storage = new Map<string, string>();
export const LocalStorage = {
  async allItems() {
    return Object.fromEntries(storage);
  },
  async getItem(key: string) {
    return storage.get(key);
  },
  async setItem(key: string, value: string) {
    storage.set(key, value);
  },
  async removeItem(key: string) {
    storage.delete(key);
  },
};
export const getApplications = vi.fn();
export const open = vi.fn();
export const closeMainWindow = vi.fn();
export const getPreferenceValues = () => ({});
export class Cache {
  private entries = new Map<string, string>();
  get(key: string) {
    return this.entries.get(key);
  }
  set(key: string, value: string) {
    this.entries.set(key, value);
  }
}
export const Icon = { Person: "person" };
export const Image = { Mask: { Circle: "circle" } };
export const Form = Object.assign(() => null, {
  Description: "Description",
  TextArea: "TextArea",
  Checkbox: "Checkbox",
  DatePicker: "DatePicker",
});
export const Color = { Green: "green" };
export const ActionPanel = Object.assign(() => null, { Section: "ActionSection", Submenu: "ActionSubmenu" });
export const Action = Object.assign(() => null, {
  SubmitForm: "SubmitForm",
  Push: "Push",
  Open: "Open",
  OpenInBrowser: "OpenInBrowser",
  CopyToClipboard: "CopyToClipboard",
  Style: { Destructive: "destructive" },
});
export const List = Object.assign(() => null, {
  Section: "Section",
  EmptyView: "EmptyView",
  Item: Object.assign(() => null, {
    Detail: Object.assign(() => null, { Metadata: Object.assign(() => null, { Label: "Label" }) }),
  }),
});
export const Toast = { Style: { Failure: "failure", Success: "success" } };
export const PopToRootType = { Immediate: "immediate" };
export const showHUD = vi.fn();
export const showToast = vi.fn();

export const oauthTokens = new Map<string, string>();
export const OAuth = {
  RedirectMethod: { Web: "web" },
  PKCEClient: class {
    constructor(public options: { providerId: string }) {}
    async getTokens() {
      const accessToken = oauthTokens.get(this.options.providerId);
      return accessToken ? { accessToken, isExpired: () => false } : undefined;
    }
    async setTokens({ accessToken }: { accessToken: string }) {
      oauthTokens.set(this.options.providerId, accessToken);
    }
    async removeTokens() {
      oauthTokens.delete(this.options.providerId);
    }
  },
};
export const LaunchType = { UserInitiated: "userInitiated" };
