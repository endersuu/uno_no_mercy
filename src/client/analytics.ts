const DEVICE_KEY = "uno-device-id";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AnalyticsEnvironment {
  storage: () => Pick<Storage, "getItem" | "setItem">;
  crypto: Pick<Crypto, "getRandomValues"> & Partial<Pick<Crypto, "randomUUID">>;
  href: string;
  referrer: string;
  language: string;
  timezone: () => string;
}

export interface ClientAnalytics {
  deviceId: string | null;
  storage: "persistent" | "ephemeral";
  language: string | null;
  timezone: string | null;
  referrer: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
}

function randomId(crypto: AnalyticsEnvironment["crypto"]): string | null {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // randomUUID requires HTTPS; getRandomValues also works on LAN HTTP.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10).join(""),
    ].join("-");
  } catch {
    return null;
  }
}

function campaignLabel(value: string | null): string | null {
  const label = value?.trim();
  return label && label.length <= 80 && /^[a-zA-Z0-9_.~ -]+$/.test(label)
    ? label
    : null;
}

/** Capture once at page entry, before room navigation changes the URL. */
export function collectAnalytics(
  environment: AnalyticsEnvironment = {
    storage: () => window.localStorage,
    crypto: window.crypto,
    href: location.href,
    referrer: document.referrer,
    language: navigator.language,
    timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
): ClientAnalytics {
  let deviceId: string | null = null;
  let storage: ClientAnalytics["storage"] = "ephemeral";
  try {
    const local = environment.storage();
    const saved = local.getItem(DEVICE_KEY);
    if (saved && UUID_V4.test(saved)) {
      deviceId = saved.toLowerCase();
      storage = "persistent";
    } else {
      deviceId = randomId(environment.crypto);
      if (deviceId) {
        local.setItem(DEVICE_KEY, deviceId);
        if (local.getItem(DEVICE_KEY) === deviceId) storage = "persistent";
      }
    }
  } catch {
    // Storage can be disabled, full, or unavailable in private browsing.
  }
  deviceId ??= randomId(environment.crypto);

  let referrer: string | null = null;
  try {
    const url = new URL(environment.referrer);
    if (url.protocol === "https:" || url.protocol === "http:")
      referrer = url.hostname.slice(0, 253);
  } catch {}
  let timezone: string | null = null;
  try {
    const value = environment.timezone();
    if (value.length <= 64 && /^[a-zA-Z0-9_+\-/]+$/.test(value))
      timezone = value;
  } catch {}
  let params = new URLSearchParams();
  try {
    params = new URL(environment.href).searchParams;
  } catch {}
  return {
    deviceId,
    storage,
    language:
      environment.language.length <= 40 &&
      /^[a-zA-Z0-9-]+$/.test(environment.language)
        ? environment.language
        : null,
    timezone,
    referrer,
    source: campaignLabel(params.get("utm_source")),
    medium: campaignLabel(params.get("utm_medium")),
    campaign: campaignLabel(params.get("utm_campaign")),
  };
}
