import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

type Budget = { windowMs: number; global: number; perIp: number };
export const abuseLimits = {
  http: { windowMs: 60_000, global: 1200, perIp: 300 },
  handshake: { windowMs: 60_000, global: 240, perIp: 120 },
  packet: { windowMs: 10_000, global: 2000, perIp: 400 },
  create: { windowMs: 60_000, global: 120, perIp: 30 },
} satisfies Record<string, Budget>;
type BudgetName = keyof typeof abuseLimits;

/** Bounded, shared budgets: reconnecting must not reset an attacker's allowance. */
export class AbuseGuard {
  private buckets = new Map<string, { count: number; until: number }>();
  private connections = 0;
  private peers = new Map<string, number>();
  constructor(
    private now = () => Date.now(),
    private maxBuckets = 4096,
    private maxConnections = 256,
    private maxPerIp = 32,
  ) {}

  prune() {
    const now = this.now();
    for (const [key, bucket] of this.buckets)
      if (bucket.until <= now) this.buckets.delete(key);
  }

  private consume(key: string, maximum: number, windowMs: number) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (!bucket && this.buckets.size >= this.maxBuckets) return false;
      bucket = { count: 0, until: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= maximum) return false;
    bucket.count++;
    return true;
  }

  take(kind: BudgetName, ip: string | null) {
    const budget = abuseLimits[kind];
    // Check the peer first so a single throttled IP cannot spend the entire global budget.
    if (
      ip !== null &&
      !this.consume(`${kind}:${ip}`, budget.perIp, budget.windowMs)
    )
      return false;
    return this.consume(kind, budget.global, budget.windowMs);
  }

  /** Reserve before Engine.IO allocates a session; release is idempotent. */
  acquire(ip: string | null): (() => void) | null {
    if (
      this.connections >= this.maxConnections ||
      (ip !== null && (this.peers.get(ip) ?? 0) >= this.maxPerIp)
    )
      return null;
    this.connections++;
    if (ip !== null) this.peers.set(ip, (this.peers.get(ip) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.connections--;
      if (ip !== null) {
        const remaining = (this.peers.get(ip) ?? 1) - 1;
        if (remaining) this.peers.set(ip, remaining);
        else this.peers.delete(ip);
      }
    };
  }
}

function normalizeIp(value: string | undefined): string | null {
  if (!value) return null;
  // A local IPv6 interface scope is not part of the peer's address identity.
  const unscoped = value.split("%", 1)[0];
  const ip = unscoped.startsWith("::ffff:") ? unscoped.slice(7) : unscoped;
  if (!isIP(ip)) return null;
  if (isIP(ip) !== 6) return ip;
  try {
    return new URL(`http://[${ip}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/** Only opt in after verifying the number of trusted reverse proxies in front of Node. */
export function clientIp(
  request: Pick<IncomingMessage, "headers" | "socket">,
  trustedProxyHops = 0,
): string | null {
  const direct = normalizeIp(request.socket.remoteAddress);
  if (trustedProxyHops === 0) return direct;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string") return direct;
  const chain = forwarded.split(",").map((part) => part.trim());
  // Work from the trusted end, never the client-controlled leftmost entry.
  if (chain.length < trustedProxyHops) return direct;
  return normalizeIp(chain[chain.length - trustedProxyHops]) ?? direct;
}
