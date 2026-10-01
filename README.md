# Desk display

A full-screen dashboard for an old phone or Fire tablet: clock, current weather with live
weather effects, a rotating photo album, and whatever is playing on your Spotify.
Plus a `/admin.html` control panel to post reminders and upload photos.

## Preview on your PC

Run `npm run preview` from this folder and open <http://localhost:4173/preview.html>.
The local preview uses sample weather, an included landscape illustration, and sample
music/reminders. It needs no credentials and makes no data API requests in sample mode.

- Choose a desktop, 4K, Fire tablet, or phone size, or enter custom dimensions.
- **Rotate screen** swaps width and height. The frame scales to fit your PC window,
  while the dashboard inside renders at the selected resolution.
- Select any weather effect and switch between sample landscape and music.
- **Open full size** opens the selected content in a new tab that adapts to your window.
  **Fullscreen** fills your monitor. Reduced-motion settings keep effects still.
- On a deployed site, open `/preview.html?key=YOUR_DASH_KEY` and choose **Live display**
  to see your connected content and automatic weather. Live mode requires the deployed
  APIs; the local static server only serves the sample preview.

Preview controls affect only your PC tab. The normal display URL keeps automatic weather,
Spotify, photos, calendar reminders, and its nighttime dimming. Very small windows can
scroll rather than cut off content. Display dimensions are CSS pixels, which can differ
from the physical screen resolution with browser zoom or device pixel scaling.

The Git repository is <https://github.com/perzival-22/desk-displays>. Its root is this
folder (`desk-display/` inside the outer workspace). Local environment files, Vercel
metadata, dependencies, personal images, and verification artifacts are ignored.

- Weather comes from Open-Meteo in the browser (no API key).
- Weather effects (clouds, rain, snow, a warm sun glow, drifting stars, or mist) render
  on a single capped canvas driven by the current condition code.
- Spotify goes through three small Vercel functions in `api/`, so your client
  secret and refresh token never touch the phone.
- Photos live in a Vercel Blob store, listed and written by `api/photos.js`.
- Reminders live as `reminders.json` in the same Blob store, via `api/reminders.js`.

What the right side shows:
1. Music is playing on any of your devices: now playing, with the album art as the background.
2. Otherwise: your photo album, one photo a minute, each blurred behind itself
   as the background (the same wash the album art uses).

The clock and current weather (temperature, conditions, today's high/low) stay on
the left the whole time. The screen dims from 10pm to 6am. You can change the dim
hours and your location in `CONFIG` at the bottom of `index.html`.

## Setup

**Requirement:** the Spotify account that creates the developer app needs Premium.

1. **Deploy to Vercel first** so you know your URL.
   `npm i -g vercel`, then run `vercel` in this folder and accept the defaults.
   Note the URL, for example `https://desk-display-kelvin.vercel.app`.

2. **Create a Spotify app** at developer.spotify.com/dashboard.
   - Redirect URI: `https://YOUR-URL/api/callback` (must match exactly)
   - API: Web API
   - Copy the Client ID and Client Secret.

3. **Add environment variables** in Vercel (Project > Settings > Environment Variables):
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `SPOTIFY_REDIRECT_URI` = `https://YOUR-URL/api/callback`
   - `DASH_KEY` = any random string (keeps strangers from reading your now playing)

   Then redeploy: `vercel --prod`.

4. **Connect Spotify once.** On your laptop, open `https://YOUR-URL/?key=YOUR_DASH_KEY`
   and click **Connect Spotify** (or open `/api/login?key=YOUR_DASH_KEY`),
   approve, and copy the refresh token from the page it shows.

5. **Add `SPOTIFY_REFRESH_TOKEN`** in Vercel with that value, and redeploy again.
   Reconnecting requires your dashboard key and a matching, short-lived OAuth state cookie.

6. **Test** `https://YOUR-URL/api/now-playing?key=YOUR_DASH_KEY` while music plays.
   You should see JSON with the track title.

## Google Calendar reminders

Open `/admin.html`, unlock it with your admin key, and use **Connect Google Calendar**.
After the one-time setup below, approve read-only calendar access with the Google account
you use on your phone. Events saved to that account's **primary calendar** appear beside
manual reminders. Check the calendar/account selected when creating an event on your phone;
events saved only on the phone, in iCloud, in Google Tasks, or in another calendar are not imported.

The open display pulls fresh events every **five minutes** (and on page load). Admin has
**Sync now** to refresh its preview immediately; reload the display for an immediate display
refresh. Sync includes ongoing and upcoming events over the next **30 days**, limited to the
first **100** occurrences. Recurring events are expanded, all-day dates keep their calendar
date, and timed events show in the viewing device's timezone. Edits, cancellations, and
deletions replace the previous results on the next successful refresh. Declined invitations
are excluded. This shows event start times as reminders; it does not send phone notifications
or use Google's per-event alert offsets.

### One-time Google setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and
   enable **Google Calendar API**. Configure the Google Auth consent screen for your app.
   If the app is in **Testing**, add your Google account as a test user.
2. Create an OAuth client with application type **Web application**. Add this authorized
   redirect URI, replacing the host with your actual deployment:
   `https://YOUR-PROJECT.vercel.app/api/google-callback`.
3. Add these server environment variables in Vercel and optionally `.env.local` for development:

   | Variable | Value |
   | --- | --- |
   | `GOOGLE_CLIENT_ID` | The Google OAuth client ID |
   | `GOOGLE_CLIENT_SECRET` | The Google OAuth client secret |
   | `GOOGLE_REDIRECT_URI` | The exact HTTPS callback URI from step 2 |
   | `GOOGLE_CALENDAR_SECRET` | A fresh random 32-byte key encoded as 64 hex characters |
   | `DASH_KEY` | The key used by your display URL; required for calendar reads |
   | `ADMIN_KEY` | Your admin key, or omit to use `DASH_KEY` for admin too |
   | `BLOB_READ_WRITE_TOKEN` | The existing public photo/reminder Blob store token |

   Generate the encryption key locally and copy it directly to your environment settings:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

4. Redeploy, open admin, select **Connect Google Calendar**, and approve calendar read access.
   The callback returns to admin and saves the connection automatically; there is no refresh
   token to copy and no second deployment needed after connecting.
5. Add a test event on your phone's primary Google calendar, then press **Sync now** in admin.
   Check it on the display after its next refresh. Edit and delete the event on your phone
   to confirm both changes sync too.

Google's [server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
describes offline access and exact redirect URI matching. External apps in Testing generally
receive refresh tokens that expire after seven days for calendar access; reconnect when prompted,
or configure the app's publishing status appropriately for ongoing use. The
[Calendar events API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
documents the read-only scope and recurrence/time filters used here.

### Storage and disconnecting

Only the refresh token and connection timestamp are saved, encrypted with AES-256-GCM under
`connections/google-calendar/*.enc` in the existing public Blob store. Those Blob URLs contain
authenticated ciphertext, never readable tokens or event details. Keep `GOOGLE_CALENDAR_SECRET`
server-only and stable across deployments; losing or changing it requires disconnecting and
reconnecting. OAuth uses a short-lived encrypted HttpOnly/Secure cookie, state validation, and PKCE.
The server retrieves events on demand and returns only titles, dates, and IDs; it never adds them
to the public manual-reminder JSON file. Manual reminders and photos keep their existing storage.

**Disconnect** deletes the stored Google connection. Calendar events disappear on the next display
refresh; manual reminders remain. It does not delete events from Google. To also remove the app's
Google authorization, remove it from your Google Account's third-party connections. On Google errors,
admin and display show a retry/reconnect message while manual reminders remain available.

Run `npm test` for mocked OAuth, encrypted persistence, reminder integration, and UI rendering checks.
These checks do not replace the real-account phone-to-display check in step 5.

## Photo album

The right side shows a rotating photo album whenever music isn't playing. Photos
live in a Vercel Blob store, so you can change them without redeploying.

1. **Add Blob storage.** In Vercel: Project > Storage > Create > Blob. Connecting
   it adds the `BLOB_READ_WRITE_TOKEN` environment variable automatically. Redeploy
   once so `/api/photos` can read it.
2. **Upload photos.** Either drag them into the store from the Vercel dashboard, or
   from this folder run `vercel blob put ./my-photo.jpg --pathname 01.jpg --access public`.
   Photos play in file-name order, so naming them `01.jpg`, `02.jpg`, ... sets the
   sequence.
3. Reload the display. New photos are picked up on load and re-checked every hour;
   `api/photos.js` only lists the store on those two occasions, which stays far
   under the free monthly operation limit.

On the free (Hobby) plan, Blob includes **1 GB of storage**, which is about **200
photos at the 5 MB ceiling** (more if they are smaller). Keep individual images at
a few MB for fast loading, and test the album at
`https://YOUR-URL/api/photos?key=YOUR_DASH_KEY`, which should return a JSON list of
image URLs.

## Control dashboard (reminders and photo upload)

Open `https://YOUR-URL/admin.html` to manage the display from a laptop or phone:

- **Reminders** post to `reminders.json` in the Blob store and appear under the
  weather on the left of the display, soonest-due first. The display re-reads them
  every 5 minutes, so a new reminder shows up within a few minutes.
- **Photos** are resized to 2000px in the browser before upload (so they stay small
  and load fast), then written into the Blob store's `photos/` folder. They join the
  rotating album on the next hourly refresh, or reload the display to see them at once.

**Admin key.** Writes are gated by `ADMIN_KEY`. Set it in Vercel
(Project > Settings > Environment Variables) to any random string, separate from
`DASH_KEY`, and redeploy. The dashboard asks for it once and keeps it for the
browser session only. If you do not set `ADMIN_KEY`, the dashboard falls back to
`DASH_KEY`; a query-param key is fine for reading but weak for a write-capable
panel, so a distinct `ADMIN_KEY` is recommended. `DASH_KEY` alone still cannot
write, because writes require the key in an `x-admin-key` header, not the URL.

Endpoints, for reference:
- `GET /api/reminders?key=KEY` and `GET /api/photos?key=KEY` accept `DASH_KEY` or `ADMIN_KEY`.
- `POST` / `DELETE` on both require the `x-admin-key` header.

## On the phone or Fire tablet (Fully Kiosk Browser)

- Start URL: `https://YOUR-URL/?key=YOUR_DASH_KEY`
- Settings > Device Management: Keep Screen On, and turn on Launch on Boot.
- Settings > Device Management > Force Screen Orientation: Landscape for the
  side-by-side clock and photo/music layout. Portrait also works: the clock and
  weather sit above the photo/music panel. The page adapts to the viewport;
  Fully controls the physical device orientation.
- Use the same Start URL and dashboard key on the Fire tablet and Moto G Play.
  Photos and Spotify come from the same account and store. Photos rotate locally
  on each device; the two slideshow positions are not synchronized.
- Photos fit completely inside their panel without cropping. Taller tablet
  layouts put larger album art above the song information. Rotating the device
  resizes both the layout and the weather canvas automatically.
- Once it looks right, set Fully Kiosk as the default home app so the phone boots into it.

See [Fully Kiosk's device settings](https://www.fully-kiosk.com/en/#configuration).

## Automatic weather

- Effects follow Open-Meteo's current condition code on load and every 15 minutes.
  Clear days show **Sunny** or **Mostly sunny**, with a warm glow; clear nights
  show **Clear night** or **Mostly clear**, with stars. **Partly cloudy** adds
  drifting clouds (and a daytime glow); **Cloudy** replaces the label Overcast
  and shows clouds. Rain, snow, fog, and storms keep their specific labels/effects.
- Location is still Portland, Maine (`CONFIG.lat` / `CONFIG.lon` in `index.html`).
  Both devices use that location, rather than requesting device GPS access.
- No effect parameter is needed. Old URLs containing `fx=rain` or another effect
  now use live weather too. For an intentional preview only, append
  `&preview=1&fx=rain` (or `cloudy`, `partly`, `sun`, `snow`, `fog`, `storm`, `stars`).
  Remove `preview=1` to resume automatic conditions.
- Failed updates retry every minute and when connectivity returns or the page
  becomes visible. Last-known readings stay visible with a delayed-update message;
  effects stop after 30 minutes without a successful update. Reduced-motion
  settings disable animation, and hidden pages pause the canvas.
- Day/night uses the API's `is_day` field; sunrise/sunset use UTC timestamps to
  avoid interpreting location time in the tablet's time zone. See the
  [Open-Meteo API documentation](https://open-meteo.com/en/docs).

## Troubleshooting

- The display now shows Spotify connection errors below the forecast. A 401 means
  the phone's URL is missing the correct `?key=YOUR_DASH_KEY`.
- **Reconnect Spotify**: an invalid or expired refresh token produces a connection
  message and a Connect Spotify link. Approve access, save the new refresh token in
  Vercel, and redeploy. A client ID, client secret, or access token is not a refresh token.
- For this deployment, register `https://desk-display-taupe.vercel.app/api/callback`
  in the Spotify developer app's Redirect URIs and use that exact value for
  `SPOTIFY_REDIRECT_URI` in Vercel. Do not leave `YOUR-PROJECT` in the value.
- A 403 from Spotify means you should check allowed users in the developer app,
  the app owner's Premium subscription, and playback permissions.
- If Spotify is connected but idle, play music on the account you connected.
  Paused playback intentionally returns to the weather/brief view.
- `.env.local` is local only; changes there do not update Vercel. Set the values in
  Vercel's Production environment and redeploy to apply them. Keep secrets out of
  `.env.example` and rotate credentials if they were exposed.
- The page is blank on the phone: check the Wi-Fi, then reload in Fully Kiosk.

Run `npm test` to check Spotify error handling, playback rendering, protected
reconnection, automatic weather mappings, preview behavior, and weather recovery.
