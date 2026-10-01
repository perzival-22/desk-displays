import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { list, put, del } from "@vercel/blob";

export const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const PREFIX = "connections/google-calendar/";
export const STATE_COOKIE = "__Host-google-calendar-state";

export function adminOK(req) {
  const expected = process.env.ADMIN_KEY || process.env.DASH_KEY;
  return Boolean(expected) && req.headers?.["x-admin-key"] === expected;
}

export function setupMissing() {
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "BLOB_READ_WRITE_TOKEN", "DASH_KEY"]
    .filter((name) => !process.env[name]);
  if (!/^[a-f0-9]{64}$/i.test(process.env.GOOGLE_CALENDAR_SECRET || "")) missing.push("GOOGLE_CALENDAR_SECRET (64 hex characters)");
  try {
    const url = new URL(process.env.GOOGLE_REDIRECT_URI);
    if (url.protocol !== "https:" || url.pathname !== "/api/google-callback" || url.search || url.hash || url.username || url.password) throw new Error();
  } catch { missing.push("GOOGLE_REDIRECT_URI (HTTPS /api/google-callback URL)"); }
  return missing;
}

export function calendarError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function encryptionKey() {
  if (!/^[a-f0-9]{64}$/i.test(process.env.GOOGLE_CALENDAR_SECRET || "")) {
    throw calendarError("google_setup", "Configure GOOGLE_CALENDAR_SECRET before connecting Google Calendar.", 503);
  }
  return Buffer.from(process.env.GOOGLE_CALENDAR_SECRET, "hex");
}

// The existing photo store is public. Only authenticated ciphertext goes into it;
// tokens and event details are never stored there as readable JSON.
export function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("desk-google-calendar-v1"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

export function unseal(value) {
  const [iv, tag, encrypted] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("desk-google-calendar-v1"));
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(encrypted), cipher.final()]).toString("utf8"));
}

export function stateCookie(value, maxAge = 600) {
  return `${STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function startAuthorization() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent",
    state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return {
    url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    cookie: stateCookie(seal({ state, verifier, issued: Date.now() })),
  };
}

export function validateState(req) {
  try {
    const cookie = (req.headers?.cookie || "").split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${STATE_COOKIE}=`))?.slice(STATE_COOKIE.length + 1);
    const data = unseal(cookie || "");
    const age = Date.now() - data.issued;
    if (typeof req.query?.state !== "string" || data.state !== req.query.state || !Number.isFinite(age) || age < 0 || age > 600000) return null;
    return data;
  } catch { return null; }
}

export function eventReminders(events) {
  return events.filter((event) => event.status !== "cancelled" &&
    !event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined"))
    .flatMap((event) => {
      const due = event.start?.dateTime || event.start?.date;
      if (!event.id || !due || !Number.isFinite(Date.parse(due))) return [];
      return [{ id: `g_${event.id}`, text: String(event.summary || "Untitled event").slice(0, 200),
        due, allDay: Boolean(event.start.date), source: "google", end: event.end?.dateTime || event.end?.date || "" }];
    });
}

export function createCalendarService(storage = { list, put, del }, request = (...args) => fetch(...args)) {
  async function connections() {
    const blobs = [];
    let cursor;
    do {
      const page = await storage.list({ prefix: PREFIX, cursor });
      blobs.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return blobs.sort((a, b) => b.pathname.localeCompare(a.pathname));
  }

  async function readConnection() {
    const [blob] = await connections();
    if (!blob) return null;
    const response = await request(blob.url, { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw calendarError("google_storage", "Could not read the Google connection. Try again.");
    try { return unseal(await response.text()); }
    catch { throw calendarError("google_storage", "Google connection could not be decrypted. Restore GOOGLE_CALENDAR_SECRET or disconnect and reconnect."); }
  }

  async function saveConnection(connection) {
    const old = await connections();
    // Immutable URLs avoid serving a cached token after reconnecting.
    await storage.put(`${PREFIX}${Date.now()}-${randomBytes(8).toString("hex")}.enc`, seal(connection), {
      access: "public", contentType: "application/octet-stream", addRandomSuffix: false,
    });
    if (old.length) await storage.del(old.map((blob) => blob.url));
  }

  async function tokenRequest(params) {
    const response = await request("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }), signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) {
      if (data.error === "invalid_grant") throw calendarError("google_reconnect", "Google access expired or was revoked. Reconnect Google Calendar.");
      throw calendarError("google_auth", "Google could not authorize the connection. Check the Google client credentials and reconnect.");
    }
    return data;
  }

  async function connect(code, verifier) {
    const data = await tokenRequest({ code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: process.env.GOOGLE_REDIRECT_URI });
    if (!data.refresh_token || (data.scope && !data.scope.split(" ").includes(SCOPE))) {
      throw calendarError("google_consent", "Google Calendar read access was not granted. Reconnect and allow calendar access.");
    }
    await saveConnection({ refreshToken: data.refresh_token, connectedAt: new Date().toISOString() });
  }

  async function disconnect() {
    // Deletion must work even if credentials or the encryption key were changed.
    const blobs = await connections();
    if (blobs.length) await storage.del(blobs.map((blob) => blob.url));
  }

  async function feed() {
    if (setupMissing().length) return { status: "setup", reminders: [] };
    const connection = await readConnection();
    if (!connection) return { status: "disconnected", reminders: [] };
    const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: connection.refreshToken });
    const now = Date.now();
    const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", showDeleted: "false",
      timeMin: new Date(now).toISOString(), timeMax: new Date(now + 30 * 86400000).toISOString(), maxResults: "100",
      fields: "items(id,summary,status,start,end,attendees(self,responseStatus)),nextPageToken" });
    const response = await request(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${token.access_token}` }, cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 401) throw calendarError("google_reconnect", "Reconnect Google Calendar to restore event sync.");
      if (response.status === 403) throw calendarError("google_access", "Google Calendar access was denied or its quota was reached. Check that Calendar API is enabled and read access was granted, then try again.");
      throw calendarError("google_unavailable", "Google Calendar could not load events. Try syncing again shortly.");
    }
    const data = await response.json();
    if (data.items !== undefined && !Array.isArray(data.items)) throw calendarError("google_unavailable", "Google Calendar returned an unreadable event list. Try again.");
    return { status: "connected", reminders: eventReminders(data.items || []), syncedAt: new Date().toISOString(), limited: Boolean(data.nextPageToken) };
  }

  return { connect, disconnect, feed, readConnection };
}

export const calendar = createCalendarService();
