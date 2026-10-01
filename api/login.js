import { randomBytes, createHmac } from "node:crypto";

// Both initial setup and reconnect require the private dashboard key.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!process.env.DASH_KEY || req.query.key !== process.env.DASH_KEY) {
    res.status(401).send("Open Connect Spotify from your display URL with its dashboard key.");
    return;
  }
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET ||
      !/^https:\/\//.test(process.env.SPOTIFY_REDIRECT_URI || "") ||
      /YOUR-/i.test(process.env.SPOTIFY_REDIRECT_URI)) {
    res.status(503).send("Set the Spotify app credentials and the actual HTTPS callback URL in Vercel first.");
    return;
  }

  const nonce = randomBytes(32).toString("hex");
  const payload = `${nonce}.${Date.now()}`;
  const signature = createHmac("sha256", process.env.DASH_KEY).update(payload).digest("hex");
  const state = `${payload}.${signature}`;
  res.setHeader("Set-Cookie", `spotify_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=600`);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: "user-read-playback-state user-read-currently-playing",
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
}
