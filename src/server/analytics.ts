import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { View } from "../shared/types.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function label(value: unknown, max = 80): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    /^[a-z0-9_.~ -]+$/i.test(value)
    ? value.trim() || null
    : null;
}
function hostname(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 253) return null;
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value.toLowerCase() ? url.hostname : null;
  } catch {
    return null;
  }
}
function timezone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/** Coarse, best-effort UA families; never a hardware fingerprint. */
export function deviceInfo(userAgent: unknown) {
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 512) : "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "unknown";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "Chrome OS"
          : /Macintosh|Mac OS X/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "unknown";
  const device_type =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))
      ? "tablet"
      : /Mobile|iPhone|iPod/.test(ua)
        ? "mobile"
        : os !== "unknown"
          ? "desktop"
          : "unknown";
  return { browser, os, device_type };
}

interface Connection {
  fields: Record<string, unknown>;
  started: number;
  lastActive: string | null;
}

/** Only live sockets are retained here; daily aggregates go to the optional store. */
export class Analytics {
  private connections = new Map<string, Connection>();
  private runId = randomUUID();
  constructor(
    private enabled = process.env.ANALYTICS_ENABLED !== "false",
    private write: (line: string) => void = (line) => console.log(line),
    private now = () => Date.now(),
    private persist?: (record: Record<string, unknown>) => void,
  ) {}

  connect(
    id: string,
    metadata: unknown,
    userAgent: unknown,
    ip: string | null,
  ) {
    if (!this.enabled || this.connections.has(id)) return;
    const m =
      metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : {};
    const validId = typeof m.deviceId === "string" && uuid.test(m.deviceId);
    const deviceId = validId
      ? (m.deviceId as string).toLowerCase()
      : randomUUID();
    const identityScope = !validId
      ? "connection"
      : m.storage === "persistent"
        ? "persistent"
        : "ephemeral";
    const connection: Connection = {
      fields: {
        connection_id: id,
        device_id: createHash("sha256")
          .update(`uno-analytics-v1:${deviceId}`)
          .digest("hex"),
        identity_scope: identityScope,
        ...deviceInfo(userAgent),
        language:
          typeof m.language === "string" &&
          /^[a-z]{2,8}(-[a-z0-9]{1,8})*$/i.test(m.language) &&
          m.language.length <= 64
            ? m.language
            : null,
        timezone: timezone(m.timezone),
        referrer: hostname(m.referrer),
        source: label(m.source),
        medium: label(m.medium),
        campaign: label(m.campaign),
        // Only the caller's existing, explicitly configured proxy policy supplies IPs.
        // This may be a VPN exit; it is never presented as a physical location.
        network_ip: ip && isIP(ip) ? ip : null,
      },
      started: this.now(),
      lastActive: null,
    };
    this.connections.set(id, connection);
    this.log(connection, "visitor_connected");
  }

  roomEntered(id: string, room: string) {
    const c = this.connections.get(id);
    if (c) this.log(c, "room_entered", { room_id: room });
  }

  observeState(id: string, view: View) {
    const c = this.connections.get(id);
    if (
      !c ||
      view.phase !== "playing" ||
      !view.roundId ||
      view.disconnected ||
      view.closed ||
      view.pausedBy !== null
    )
      return;
    // Re-emitting a state does not generate a log per move. A new UTC day does,
    // so a game spanning midnight contributes to both days' active-player counts.
    const key = `${view.roundId}:${new Date(this.now()).toISOString().slice(0, 10)}`;
    if (c.lastActive === key) return;
    c.lastActive = key;
    this.log(c, "player_active", {
      room_id: view.room,
      round_id: view.roundId,
    });
  }

  disconnect(id: string, reason: string) {
    const c = this.connections.get(id);
    if (!c) return;
    this.connections.delete(id);
    this.log(c, "visitor_disconnected", {
      duration_ms: Math.max(0, this.now() - c.started),
      reason: label(reason, 64),
    });
  }

  private log(
    c: Connection,
    event: string,
    extra: Record<string, unknown> = {},
  ) {
    const record = {
      kind: "uno-analytics",
      schemaVersion: 1,
      at: new Date(this.now()).toISOString(),
      event,
      run_id: this.runId,
      ...c.fields,
      ...extra,
    };
    try {
      this.write(JSON.stringify(record));
    } catch {
      // Telemetry failures must not interrupt a game or its acknowledgements.
    }
    try {
      this.persist?.(record);
    } catch {
      // The database and stdout sinks fail independently.
    }
  }
}
