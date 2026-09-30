import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { PluginInstance } from "./plugin-instance.js";
import { createChannelRuntimeContextRegistry } from "./runtime/channel-runtime-contexts.js";

type NativeDeliveryApi = {
  setWhatsAppRuntime(runtime: PluginRuntime): void;
  getWhatsAppRuntime(): PluginRuntime;
  getActiveWebListener(accountId: string): unknown;
  createAcceptedWhatsAppSendResult(
    kind: "text",
    id: string,
  ): {
    kind: "text";
    messageId: string;
    keys: Array<{ id: string }>;
    providerAccepted: boolean;
  };
  sendMessageWhatsApp(
    to: string,
    body: string,
    options: {
      cfg: OpenClawConfig;
      accountId: string;
      verbose: boolean;
      onPlatformSendDispatch?: () => Promise<void>;
    },
  ): Promise<{ messageId: string; toJid: string }>;
};

const accountId = "native-owner-test";
const runtimeContexts = createChannelRuntimeContextRegistry();
const currentRuntime = { channel: { runtimeContexts } } as PluginRuntime;
const replacementRuntime = {
  channel: { runtimeContexts: createChannelRuntimeContextRegistry() },
} as PluginRuntime;
let api: NativeDeliveryApi;
const cleanups: Array<() => void | Promise<unknown>> = [];

beforeAll(async () => {
  api = await loadBundledPluginFacade<NativeDeliveryApi>({
    pluginId: "whatsapp",
    artifactBasename: "native-delivery.test-api.ts",
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function prepareReplacement() {
  const current = new PluginInstance("whatsapp");
  const replacement = new PluginInstance("whatsapp");
  cleanups.push(
    () => current.dispose(),
    () => replacement.dispose(),
  );
  const sendMessage = vi.fn(async () =>
    api.createAcceptedWhatsAppSendResult("text", "owned-message"),
  );
  const listener = { sendMessage, sendComposingTo: vi.fn(async () => {}) };
  const lease = current.run(() => {
    api.setWhatsAppRuntime(currentRuntime);
    expect(api.getWhatsAppRuntime()).toBe(currentRuntime);
    return runtimeContexts.register({
      channelId: "whatsapp",
      accountId,
      capability: "connection-controller",
      context: { getActiveListener: () => listener },
    });
  });
  cleanups.push(() => lease.dispose());
  replacement.run(() => {
    api.setWhatsAppRuntime(replacementRuntime);
    expect(api.getWhatsAppRuntime()).toBe(replacementRuntime);
  });
  expect(current.run(() => api.getWhatsAppRuntime())).toBe(currentRuntime);
  // Stop ordinary calls to the donor without disposing its live connection lease.
  current.quiesce();
  const send = (
    options: {
      accountId?: string;
      onPlatformSendDispatch?: () => Promise<void>;
    } = {},
  ) =>
    replacement.run(() =>
      api.sendMessageWhatsApp("+15551234567", "after replacement", {
        cfg: { channels: { whatsapp: {} } },
        accountId,
        verbose: false,
        ...options,
      }),
    );
  return { replacement, listener, sendMessage, lease, send };
}

describe("WhatsApp native delivery across managed plugin instances", () => {
  it("sends from the replacement through the current instance's retained connection lease", async () => {
    const { replacement, listener, sendMessage, send } = prepareReplacement();
    await expect(send()).resolves.toMatchObject({ messageId: "owned-message" });
    expect(replacement.run(() => api.getActiveWebListener(accountId))).toBe(listener);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "+15551234567",
      "after replacement",
      undefined,
      undefined,
      { accountId },
    );
  });

  it("rejects an already revoked lease before native send", async () => {
    const { lease, sendMessage, send } = prepareReplacement();
    lease.dispose();
    await expect(send()).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects lease revocation during dispatch before the captured listener can send", async () => {
    const { lease, listener, sendMessage, send } = prepareReplacement();
    const dispatch = vi.fn(async () => {
      expect(api.getActiveWebListener(accountId)).toBe(listener);
      lease.dispose();
    });
    await expect(send({ onPlatformSendDispatch: dispatch })).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not borrow another account's retained listener", async () => {
    const { sendMessage, send } = prepareReplacement();
    await expect(send({ accountId: "other-account" })).rejects.toThrow(
      "No active WhatsApp Web listener (account: other-account)",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects at final send when the retained listener belongs only to another account", async () => {
    const { lease, listener, sendMessage, send } = prepareReplacement();
    const dispatch = vi.fn(async () => {
      lease.dispose();
      const otherLease = runtimeContexts.register({
        channelId: "whatsapp",
        accountId: "other-account",
        capability: "connection-controller",
        context: { getActiveListener: () => listener },
      });
      cleanups.push(() => otherLease.dispose());
      expect(api.getActiveWebListener("other-account")).toBe(listener);
    });
    await expect(send({ onPlatformSendDispatch: dispatch })).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a listener replaced during dispatch instead of sending through stale authority", async () => {
    const { sendMessage, send } = prepareReplacement();
    const otherSend = vi.fn();
    const dispatch = vi.fn(async () => {
      const lease = runtimeContexts.register({
        channelId: "whatsapp",
        accountId,
        capability: "connection-controller",
        context: { getActiveListener: () => ({ sendMessage: otherSend }) },
      });
      cleanups.push(() => lease.dispose());
    });
    await expect(send({ onPlatformSendDispatch: dispatch })).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(dispatch).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(otherSend).not.toHaveBeenCalled();
  });
});
