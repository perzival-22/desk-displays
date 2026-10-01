// The photo album's blob store.
//   GET    lists the images (read gate: DASH_KEY or ADMIN_KEY). The display
//          fetches this on load and hourly, then rotates client-side, so
//          listing stays far under the free op cap.
//   POST   uploads one image sent as a base64 data URL (admin only).
//   DELETE removes one image by its blob url (admin only).
import { list, put, del } from "@vercel/blob";

const IMAGE = /\.(jpe?g|png|webp|gif|avif)$/i;
const DATA_URL = /^data:image\/(jpeg|png|webp);base64,(.+)$/;

// Reads are open to the display key or the admin key.
function readOK(req) {
  const k = req.query.key;
  const dash = process.env.DASH_KEY;
  const admin = process.env.ADMIN_KEY;
  if (!dash && !admin) return true;
  return k === dash || (admin && k === admin);
}

// Writes need the admin key (falls back to DASH_KEY if no ADMIN_KEY is set).
function adminOK(req) {
  const provided = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_KEY || process.env.DASH_KEY;
  return Boolean(expected) && provided === expected;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    if (!readOK(req)) {
      res.status(401).json({ code: "dashboard_key", error: "Open the display using the URL with your dashboard key." });
      return;
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      res.json({ photos: [], setup: true, error: "Connect a Vercel Blob store to show photos." });
      return;
    }
    try {
      const found = [];
      let cursor;
      do {
        const page = await list({ cursor, limit: 1000 });
        for (const blob of page.blobs) if (IMAGE.test(blob.pathname)) found.push(blob);
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      // Order by pathname so the slideshow follows the file names.
      found.sort((a, b) => a.pathname.localeCompare(b.pathname));
      res.json({ photos: found.map((blob) => blob.url) });
    } catch {
      res.status(502).json({ error: "Could not load photos. Retrying shortly." });
    }
    return;
  }

  // Everything past here is a write.
  if (!adminOK(req)) {
    res.status(401).json({ error: "Admin key required." });
    return;
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(503).json({ error: "Connect a Vercel Blob store first." });
    return;
  }

  try {
    if (req.method === "POST") {
      const m = DATA_URL.exec((req.body && req.body.dataUrl) || "");
      if (!m) {
        res.status(400).json({ error: "Send an image as a base64 data URL." });
        return;
      }
      const buf = Buffer.from(m[2], "base64");
      // The dashboard downscales before sending; this guards the 4.5 MB body cap.
      if (buf.length > 4_300_000) {
        res.status(413).json({ error: "Image is too large after processing. Try a smaller photo." });
        return;
      }
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const safe = String((req.body && req.body.name) || "photo").replace(/[^a-z0-9._-]/gi, "_").slice(0, 40) || "photo";
      // Upload time in the name keeps new photos in a sensible slideshow order.
      const pathname = `photos/${Date.now()}-${safe}.${ext}`;
      const { url } = await put(pathname, buf, { access: "public", contentType: `image/${m[1]}`, addRandomSuffix: false });
      res.json({ ok: true, url });
      return;
    }

    if (req.method === "DELETE") {
      const url = req.query.url;
      if (!url) {
        res.status(400).json({ error: "Missing photo url." });
        return;
      }
      await del(url);
      res.json({ ok: true });
      return;
    }

    res.status(405).json({ error: "Method not allowed." });
  } catch {
    res.status(502).json({ error: "Photo operation failed. Try again." });
  }
}
