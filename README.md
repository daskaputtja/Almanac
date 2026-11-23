# Almanac

**Monitoring, history and statistics for your [Silo](https://siloserver.org) media server.**

Almanac is a self-hosted companion dashboard for Silo. It shows who is watching what right now, keeps a permanent record of every play, and turns that history into stats and graphs.

> [!WARNING]
> Almanac is in early development and nothing is ready to use yet. Silo itself is pre-release, and its API may change before 1.0.

## Planned features

### Live activity
- Every active stream on one page, with poster, user, device and progress
- Direct play, remux or transcode, with Silo's reason for each transcode
- Source and target resolution, and whether the stream is local or remote
- Updates in real time over Silo's event stream

### History
- A permanent, searchable log of every play
- Filter by user, title, device, platform, IP address or date
- Detail for each play: time actually watched, pauses, client, and playback method

### Statistics and graphs
- Most watched titles, most active users, popular platforms and devices
- Plays by day, by hour and by day of the week
- Direct play versus transcode trends over time
- Per-user pages showing each person's watch time and habits

### Library
- Recently added media
- Per-library counts and file details

### Later
- Notifications to Discord and other services
- Recently added newsletters
- A yearly recap for each user
- Rules for streams, such as stream limits or transcode policies

## How it works

Almanac connects to Silo with a read-only, admin-owned API key that has the `admin:monitor:read` scope. It listens to Silo's realtime event stream and periodically checks the session and history APIs. Everything it collects goes into its own database, so your history stays even after Silo prunes its records.

```
Silo server  ──(REST + WebSocket)──▶  Almanac backend  ──▶  SQLite
                                           │
                                           ▼
                                   Web dashboard (browser)
```

## Tech stack

- **Backend:** TypeScript on Node.js
- **Frontend:** React, Vite, TanStack Query, TanStack Table and Tailwind
- **Database:** SQLite through Drizzle ORM
- **Silo API types:** generated from Silo's OpenAPI specification
- **Deployment:** a single Docker image

## Getting started

Installation instructions will be added once there is a first release. The plan is a single container:

```yaml
services:
  almanac:
    image: ghcr.io/daskaputtja/almanac:latest
    ports:
      - "8191:8191"
    environment:
      SILO_URL: http://silo:8090
      SILO_API_KEY: sa_your_key_here
    volumes:
      - ./data:/data
```

### Creating a Silo API key

As a Silo administrator, create an API key with the `admin:monitor:read` scope. You can also add `admin:sessions:control` if you want Almanac to pause, stop or message streams later.

## Contributing

The project is just getting started. Issues and ideas are welcome.

## Licence

[GNU Affero General Public License v3.0](LICENSE)

## Disclaimer

Almanac is an independent community project. It is not affiliated with or endorsed by Silo Media L.L.C. "Silo" and the Silo logo are trademarks of Silo Media L.L.C.
