import { adminOK, calendar, setupMissing, startAuthorization } from "../lib/google-calendar.js";

export function createHandler(service = calendar) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!adminOK(req)) return res.status(401).json({ error: "Admin key required." });
    try {
      if (req.method === "DELETE") {
        if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: "Connect the Vercel Blob store first." });
        await service.disconnect();
        return res.json({ status: "disconnected" });
      }
      if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed." });
      const missing = setupMissing();
      if (missing.length) return res.status(req.method === "GET" ? 200 : 503).json({ status: "setup", missing,
        error: `Google Calendar setup needed: ${missing.join(", ")}.` });
      if (req.method === "POST") {
        const auth = startAuthorization();
        res.setHeader("Set-Cookie", auth.cookie);
        return res.json({ url: auth.url });
      }
      return res.json(await service.feed());
    } catch (error) {
      return res.status(error.status || 502).json({ code: error.code || "google_unavailable",
        error: error.code ? error.message : "Could not reach Google Calendar or save its connection. Try again." });
    }
  };
}

export default createHandler();
