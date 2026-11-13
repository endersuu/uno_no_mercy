import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { AbuseGuard, abuseLimits, clientIp } from "../src/server/abuse.js";

function request(remoteAddress: string, forwarded?: string) {
  return {
    headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    socket: { remoteAddress },
  } as IncomingMessage;
}

test("client IP ignores spoofed forwarded headers unless proxy trust is explicit", () => {
  assert.equal(
    clientIp(request("::ffff:192.0.2.1", "198.51.100.2")),
    "192.0.2.1",
  );
  assert.equal(
    clientIp(request("10.0.0.1", "203.0.113.9, 198.51.100.2"), 1),
    "198.51.100.2",
  );
  assert.equal(
    clientIp(request("10.0.0.1", "203.0.113.9, 198.51.100.2, 10.0.0.2"), 2),
    "198.51.100.2",
  );
  assert.equal(clientIp(request("10.0.0.1", "garbage"), 1), "10.0.0.1");
  assert.equal(clientIp(request("10.0.0.1", "198.51.100.2"), 2), "10.0.0.1");
});

test("equivalent IPv6 addresses share a budget and scoped addresses cannot throw", () => {
  assert.equal(clientIp(request("2001:0db8:0:0::1")), "2001:db8::1");
  assert.equal(clientIp(request("fe80::1%eth0")), "fe80::1");
  assert.equal(clientIp(request("127.0.0.1", "fe80::1%eth0"), 1), "fe80::1");
  assert.equal(clientIp(request("not-an-address")), null);
});

test("a reconnect cannot reset room-creation budgets; other peers can still create", () => {
  let now = 0;
  const guard = new AbuseGuard(() => now);
  for (let i = 0; i < abuseLimits.create.perIp; i++) {
    const release = guard.acquire("192.0.2.1");
    assert.ok(release);
    assert.equal(guard.take("create", "192.0.2.1"), true);
    release();
  }
  for (let i = 0; i < 200; i++)
    assert.equal(guard.take("create", "192.0.2.1"), false);
  assert.equal(guard.take("create", "192.0.2.2"), true);
  now = 59_999;
  assert.equal(guard.take("create", "192.0.2.1"), false);
  now = 60_000;
  assert.equal(guard.take("create", "192.0.2.1"), true);
});

test("global budgets bound distributed traffic even when peer IP is unavailable", () => {
  let now = 0;
  const guard = new AbuseGuard(() => now);
  for (let i = 0; i < abuseLimits.create.global; i++)
    assert.equal(guard.take("create", null), true);
  assert.equal(guard.take("create", null), false);
  // Admission and HTTP budgets remain independent from room creation.
  assert.equal(guard.take("handshake", null), true);
  assert.equal(guard.take("http", null), true);
  now = 60_000;
  assert.equal(guard.take("create", null), true);
});

test("connection slots enforce peer/global caps and disconnect release is idempotent", () => {
  const guard = new AbuseGuard(() => 0, 4096, 3, 2);
  const a = guard.acquire("a"),
    b = guard.acquire("a");
  assert.ok(a);
  assert.ok(b);
  assert.equal(guard.acquire("a"), null);
  const c = guard.acquire("b");
  assert.ok(c);
  assert.equal(guard.acquire("c"), null);
  a();
  a();
  const d = guard.acquire("c");
  assert.ok(d);
  assert.equal(guard.acquire(null), null);
  b();
  c();
  d();
  const all = [guard.acquire(null), guard.acquire(null), guard.acquire(null)];
  assert.ok(all.every(Boolean));
  assert.equal(guard.acquire(null), null);
});

test("limiter storage is bounded under many identities and expired entries are reclaimed", () => {
  let now = 0;
  const guard = new AbuseGuard(() => now, 3);
  assert.equal(guard.take("create", "a"), true);
  assert.equal(guard.take("create", "b"), true);
  for (let i = 0; i < 1000; i++)
    assert.equal(guard.take("create", `new-${i}`), false);
  assert.equal(guard.take("create", "a"), true);
  now = 60_000;
  guard.prune();
  assert.equal(guard.take("create", "c"), true);
});

test("packet and HTTP budgets reject repeated traffic independently and recover", () => {
  let now = 0;
  const guard = new AbuseGuard(() => now);
  for (let i = 0; i < abuseLimits.packet.perIp; i++)
    assert.equal(guard.take("packet", "a"), true);
  assert.equal(guard.take("packet", "a"), false);
  assert.equal(guard.take("packet", "b"), true);
  for (let i = 0; i < abuseLimits.http.perIp; i++)
    assert.equal(guard.take("http", "a"), true);
  assert.equal(guard.take("http", "a"), false);
  now = 10_000;
  assert.equal(guard.take("packet", "a"), true);
  assert.equal(guard.take("http", "a"), false);
});
