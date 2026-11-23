# Almanac

**Monitoring, history and statistics for your [Silo](https://siloserver.org) media server.**

Almanac is a self-hosted companion dashboard for Silo. It shows who is watching what right now, keeps a permanent record of every play, and turns that history into stats and graphs.

> [!WARNING]
> Almanac is in early development. The live Activity page works; everything else is still planned. Silo itself is pre-release, and its API may change before 1.0.

![The Almanac Activity page, showing live streams with demo data](docs/activity.png)

## Features

### Live activity ✅
- Every active stream on one page, with poster, user, player, IP address and live progress
- Totals for streams, playback methods and bandwidth
- Search, filter by playback method, and sort
- Direct play, remux or transcode, with Silo's reason for each transcode
- Source and target resolution, and whether the stream is local or remote
- Updates every few seconds without reloading the page

### History (planned)
- A permanent, searchable log of every play
- Filter by user, title, device, platform, IP address or date
- Detail for each play: time actually watched, pauses, client, and playback method

### Statistics and graphs (planned)
- Most watched titles, most active users, popular platforms and devices
- Plays by day, by hour and by day of the week
- Direct play versus transcode trends over time
- Per-user pages showing each person's watch time and habits

### Library (planned)
- Recently added media
- Per-library counts and file details

### Later
- Notifications to Discord and other services
- Recently added newsletters
- A yearly recap for each user
- Rules for streams, such as stream limits or transcode policies

## How it works

Almanac connects to Silo with an API key owned by a Silo administrator. Every few seconds it asks Silo for the current playback sessions, and it pushes changes to open dashboards straight away.

```
Silo server  ──(REST API)──▶  Almanac server  ──(live updates)──▶  Your browser
```

Later versions will also listen to Silo's realtime events and keep their own database, so your history stays even after Silo prunes its records.

## Getting started

### 1. Create a Silo API key

1. Log in to Silo as an administrator.
2. Open the API keys section of the admin settings.
3. Create a key called `Almanac` with only the **`admin:monitor:read`** scope. This makes it read-only.
4. Copy the key, which starts with `sa_`. Silo only shows it once.

### 2. Run Almanac with Docker

```yaml
services:
  almanac:
    image: ghcr.io/daskaputtja/almanac:latest
    container_name: almanac
    restart: unless-stopped
    ports:
      - "8191:8191"
    environment:
      SILO_URL: https://silo.example.com
      SILO_API_KEY: sa_your_key_here
      ALMANAC_USERNAME: admin
      ALMANAC_PASSWORD: change-me
```

Then open `http://your-server:8191`.

### Settings

| Variable | Required | Default | What it does |
|---|---|---|---|
| `SILO_URL` | Yes | | Your Silo server's address, e.g. `https://silo.example.com` |
| `SILO_API_KEY` | Yes | | The API key from step 1 |
| `ALMANAC_USERNAME` | No | | Username for Almanac's login prompt |
| `ALMANAC_PASSWORD` | No | | Password for Almanac's login prompt |
| `PORT` | No | `8191` | The port Almanac listens on |
| `POLL_INTERVAL_SECONDS` | No | `5` | How often to ask Silo for activity |
| `SILO_MOCK` | No | `false` | Set to `true` to show made-up demo data instead of a real server |

> [!IMPORTANT]
> Almanac shows usernames and IP addresses. If it can be reached from the internet, set `ALMANAC_USERNAME` and `ALMANAC_PASSWORD`, and put it behind HTTPS (for example with your existing reverse proxy).

## Development

You need Node.js 22 or newer.

```bash
npm install
cp .env.example .env    # then fill in SILO_URL and SILO_API_KEY, or set SILO_MOCK=true
npm run dev             # opens the dashboard on http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Runs the server and dashboard with live reload |
| `npm test` | Runs the tests |
| `npm run typecheck` | Checks types in the server and dashboard |
| `npm run build` | Builds everything into `dist/` |
| `npm start` | Runs the built app |

### Project layout

```
server/            The Almanac server (Hono on Node.js)
  silo/            Talking to Silo: API client, response types, demo data
  activity/        Turning Silo sessions into Almanac's activity view
shared/            Types shared by the server and the dashboard
web/               The dashboard (React, Vite, Tailwind)
test/              Tests (Vitest)
```

The dashboard never reads Silo's API responses directly. The server converts them into Almanac's own types in `server/activity/map.ts`, so when Silo's API changes, that is the only place that needs fixing.

## Tech stack

- **Server:** TypeScript on Node.js with Hono
- **Dashboard:** React, Vite and Tailwind CSS
- **Tests:** Vitest
- **Deployment:** a single Docker image, built automatically and published to GitHub Container Registry

## Contributing

The project is just getting started. Issues and ideas are welcome.

## Licence

[GNU Affero General Public License v3.0](LICENSE)

## Disclaimer

Almanac is an independent community project. It is not affiliated with or endorsed by Silo Media L.L.C. "Silo" and the Silo logo are trademarks of Silo Media L.L.C.
