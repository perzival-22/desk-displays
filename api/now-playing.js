// Returns a small JSON summary of what's playing on any of your Spotify devices.
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const PLAYER_URL = "https://api.spotify.com/v1/me/player?additional_types=episode";

// Reused while the serverless function stays warm, so we don't refresh on every poll.
let cached = { token: null, expires: 0 };

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expires) {
    return cached.token;
  }

  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env.SPOTIFY_REFRESH_TOKEN,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const reconnect = data.error === "invalid_grant";
    throw Object.assign(new Error(reconnect
      ? "Spotify connection expired or is invalid. Reconnect Spotify."
      : "Spotify could not sign in. Check the app credentials in Vercel."), {
      code: reconnect ? "spotify_reconnect" : "spotify_credentials",
    });
  }

  const data = await r.json();
  if (!data.access_token) throw new Error("Missing Spotify access token");
  if (data.refresh_token) {
    console.warn("Spotify issued a new refresh token. Update SPOTIFY_REFRESH_TOKEN if now-playing stops working.");
  }

  cached = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cached.token;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (process.env.DASH_KEY && req.query.key !== process.env.DASH_KEY) {
    res.status(401).json({ code: "dashboard_key", error: "Open the display using the URL with your dashboard key." });
    return;
  }

  if (!process.env.SPOTIFY_REFRESH_TOKEN) {
    res.json({ playing: false, setup: true, code: "spotify_setup", error: "Connect Spotify to show your music." });
    return;
  }

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    res.status(503).json({ code: "spotify_credentials", error: "Spotify app credentials are missing in Vercel." });
    return;
  }

  try {
  const token = await getAccessToken();
  if (!token) {
    res.status(502).json({ error: "Could not refresh the Spotify token" });
    return;
  }

  const r = await fetch(PLAYER_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });

  if (r.status === 204) {
    res.json({ playing: false });
    return;
  }
  if (!r.ok) {
    if (r.status === 401) cached = { token: null, expires: 0 };
    res.status(502).json({ code: "spotify_playback", error: r.status === 403
      ? "Spotify denied playback access. Check the app's allowed users and playback permissions."
      : `Spotify is unavailable (${r.status}). Retrying shortly.` });
    return;
  }

  const p = await r.json();
  const item = p.item;
  if (!item) {
    res.json({ playing: false });
    return;
  }

  const isEpisode = item.type === "episode";
  const images = isEpisode ? item.images || [] : (item.album && item.album.images) || [];

  res.json({
    playing: Boolean(p.is_playing),
    title: item.name,
    artist: isEpisode
      ? (item.show && item.show.name) || ""
      : (item.artists || []).map((a) => a.name).join(", "),
    album: isEpisode ? "" : (item.album && item.album.name) || "",
    art: images.length ? images[0].url : "",
    progress: p.progress_ms || 0,
    duration: item.duration_ms || 0,
    device: (p.device && p.device.name) || "",
  });
  } catch (error) {
    res.status(502).json({
      code: error.code === "spotify_reconnect" ? error.code : "spotify_unavailable",
      error: ["spotify_reconnect", "spotify_credentials"].includes(error.code)
        ? error.message : "Cannot reach Spotify. Retrying shortly.",
    });
  }
}
