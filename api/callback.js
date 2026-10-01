import { createHmac, timingSafeEqual } from "node:crypto";

// Shows the token only after a dashboard-key-authorized OAuth round trip.
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const { state } = req.query;
  const cookie = (req.headers.cookie || "").split(";").map((s) => s.trim())
    .find((s) => s.startsWith("spotify_state="))?.slice("spotify_state=".length);
  const parts = typeof state === "string" ? state.split(".") : [];
  const [nonce, issuedAt, signature] = parts;
  const age = Date.now() - Number(issuedAt);
  const expected = process.env.DASH_KEY && parts.length === 3
    ? createHmac("sha256", process.env.DASH_KEY).update(`${nonce}.${issuedAt}`).digest("hex") : "";
  if (!expected || cookie !== state || !/^[a-f0-9]{64}$/.test(signature || "") ||
      !Number.isFinite(age) || age < 0 || age > 600000 ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(400).send("This Spotify connection link is invalid or expired. Open Connect Spotify on your display again.");
    return;
  }
  res.setHeader("Set-Cookie", "spotify_state=; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=0");

  const { code, error } = req.query;
  if (error || !code) {
    res.status(400).send("Spotify approval was cancelled or no code was returned. Open Connect Spotify on your display to try again.");
    return;
  }

  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  try {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await r.json();

  if (!r.ok || !data.refresh_token) {
    res.status(502).send("Spotify could not complete the connection. Check the client credentials and exact callback URL, then reconnect.");
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.5">
<h1 style="font-size:22px">Spotify is connected</h1>
<p>Copy this refresh token. In Vercel, add it as the environment variable <b>SPOTIFY_REFRESH_TOKEN</b>, then redeploy.</p>
<textarea readonly rows="5" style="width:100%;font-size:14px" onclick="this.select()">${data.refresh_token}</textarea>
<p>Keep this token private. After redeploying, reload your display and play music on this Spotify account.</p>
</body>`);
  } catch {
    res.status(502).send("Could not reach Spotify. Open Connect Spotify on your display to try again.");
  }
}
