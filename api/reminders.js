// Reminders, stored as a single JSON blob so nothing new needs provisioning.
//   GET    returns the list (read gate: DASH_KEY or ADMIN_KEY). The display
//          polls this every few minutes.
//   POST   adds a reminder { text, due? } (admin only).
//   DELETE removes one by ?id= (admin only).
import { list, put } from "@vercel/blob";
import { calendar } from "../lib/google-calendar.js";

const FILE = "reminders.json";

function readOK(req) {
  const k = req.query.key;
  const dash = process.env.DASH_KEY;
  const admin = process.env.ADMIN_KEY;
  if (!dash && !admin) return true;
  return Boolean((dash && k === dash) || (admin && k === admin));
}

function adminOK(req) {
  const provided = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_KEY || process.env.DASH_KEY;
  return Boolean(expected) && provided === expected;
}

async function readAll() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return [];
  const { blobs } = await list({ prefix: FILE });
  const found = blobs.find((b) => b.pathname === FILE);
  if (!found) return [];
  // Cache-bust so a fresh write is read back immediately.
  const r = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

async function writeAll(items) {
  await put(FILE, JSON.stringify(items), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

export function createHandler({ read = readAll, write = writeAll, calendarService = calendar } = {}) {
return async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    if (!readOK(req)) {
      res.status(401).json({ code: "dashboard_key", error: "Open with your dashboard key." });
      return;
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.json({ reminders: [], setup: true });
      return;
    }
    try {
      const reminders = await read();
      let google;
      try { google = await calendarService.feed(); }
      catch (error) {
        google = { status: "error", code: error.code || "google_unavailable",
          error: error.code ? error.message : "Google Calendar is temporarily unavailable. Open admin to retry." };
      }
      const { reminders: events = [], ...googleStatus } = google;
      res.json({ reminders: [...reminders, ...events], google: googleStatus });
    } catch {
      res.status(502).json({ error: "Could not load reminders." });
    }
    return;
  }

  if (!adminOK(req)) {
    res.status(401).json({ error: "Admin key required." });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: "Connect a Vercel Blob store to save reminders." });
    return;
  }

  try {
    if (req.method === "POST") {
      const text = (req.body && String(req.body.text || "")).trim();
      if (!text) {
        res.status(400).json({ error: "Reminder text is required." });
        return;
      }
      const due = req.body.due ? String(req.body.due) : "";
      const items = await read();
      items.push({
        id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text.slice(0, 200),
        due,
        created: Date.now(),
      });
      await write(items);
      res.json({ ok: true, reminders: items });
      return;
    }

    if (req.method === "DELETE") {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: "Missing id." });
        return;
      }
      if (String(id).startsWith("g_")) {
        res.status(400).json({ error: "Edit or delete this event in Google Calendar. The display will sync the change." });
        return;
      }
      const items = (await read()).filter((r) => r.id !== id);
      await write(items);
      res.json({ ok: true, reminders: items });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch {
    res.status(502).json({ error: "Could not save reminders. Try again." });
  }
};
}

export default createHandler();
