import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { collectAnalytics } from "../src/client/analytics.js";

function environment() {
  const values = new Map<string, string>();
  return {
    storage: () => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    }),
    crypto: webcrypto as unknown as Crypto,
    href: "https://uno.example/?utm_source=group&utm_medium=chat&utm_campaign=weekend&token=private",
    referrer: "https://social.example/private/messages?token=secret#private",
    language: "zh-CN",
    timezone: () => "Asia/Shanghai",
  };
}

test("a browser ID survives refresh and URL changes without depending on network identity", () => {
  const env = environment();
  const first = collectAnalytics(env);
  env.href = "https://uno.example/?room=different-room";
  const second = collectAnalytics(env);
  assert.equal(first.storage, "persistent");
  assert.equal(second.deviceId, first.deviceId);
  assert.match(first.deviceId!, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  assert.equal(first.source, "group");
  assert.equal(first.medium, "chat");
  assert.equal(first.campaign, "weekend");
  assert.equal(first.referrer, "social.example");
  assert.doesNotMatch(JSON.stringify(first), /private|secret|token|messages/);
});

test("disabled or full storage keeps analytics optional and uses an ephemeral ID", () => {
  const denied = environment();
  denied.storage = () => {
    throw Error("SecurityError");
  };
  const full = environment();
  full.storage = () => ({
    getItem: () => null,
    setItem: () => {
      throw Error("QuotaExceededError");
    },
  });
  for (const env of [denied, full]) {
    const result = collectAnalytics(env);
    assert.equal(result.storage, "ephemeral");
    assert.ok(result.deviceId);
    assert.equal(result.source, "group");
  }
});

test("LAN HTTP uses cryptographic random values and repairs malformed stored IDs", () => {
  const env = environment();
  env.storage().setItem("uno-device-id", "not-a-device-id");
  const result = collectAnalytics({
    ...env,
    crypto: {
      getRandomValues: (array) => env.crypto.getRandomValues(array),
    },
  });
  assert.equal(result.storage, "persistent");
  assert.match(
    result.deviceId!,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(env.storage().getItem("uno-device-id"), result.deviceId);
});

test("unavailable crypto and timezone do not block the game; attribution is bounded", () => {
  const result = collectAnalytics({
    ...environment(),
    crypto: {
      getRandomValues: () => {
        throw Error("unavailable");
      },
    },
    href: `https://uno.example/?utm_source=${"x".repeat(81)}&utm_medium=https://secret.example&ch=private&utm_campaign=hello%0Aworld`,
    referrer: "file:///private/file.html",
    language: "zh-CN\nsecret",
    timezone: () => {
      throw Error("unavailable");
    },
  });
  assert.deepEqual(result, {
    deviceId: null,
    storage: "ephemeral",
    language: null,
    timezone: null,
    referrer: null,
    source: null,
    medium: null,
    campaign: null,
  });
});
