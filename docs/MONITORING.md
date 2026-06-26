# Operational Monitoring

How Contador stays observable for a solo operator — so the platform doesn't
quietly rot (the CI hang of May–June 2026 went unnoticed for ~6 weeks because
nothing surfaced failures). Two layers: **CI failure alerts** (built-in, no
setup) and **uptime monitoring** (5-minute external setup, recommended).

---

## 1. CI failure alert (automatic — already wired)

`.github/workflows/ci-failure-alert.yml` runs after every `Test` workflow run.

- **On Test failure:** opens a GitHub Issue labelled `ci-failure` in the repo,
  with a link to the failing run. If one is already open, it comments instead of
  duplicating.
- **On Test success:** auto-closes any open `ci-failure` issue with a comment.

So a red build always produces a visible Issue; you don't need to watch the
Actions tab. Subscribe to repo Issue notifications (or watch the repo) to get
emailed/pinged.

**To verify it works:** intentionally break a unit test on a throwaway branch,
push it, and confirm an Issue opens; revert and confirm it closes.

> Note: `workflow_run` events fire only for workflows present on the default
> branch (`main`). This alert is active once the workflow file is on `main`.

---

## 2. Uptime monitoring for `/health` (recommended — 5 min setup)

The app exposes `GET /health`, which returns **503** when starting up or when
MongoDB is disconnected, and **200** when healthy. Set up a free external
monitor to ping it so you learn the app is down before a user does.

### Setup (one-time)

1. Create a free monitor (UptimeRobot, Better Stack, or GitHub Actions-based).
2. Monitor URL: `https://<your-railway-domain>/health` (the public domain
   fronting the Express server; same host as `WEBHOOK_URL`).
3. Check interval: **5 minutes**.
4. **Alert condition:** treat *consecutive* failures as down, not a single 503.
   A single 503 may be a redeploy or a brief Mongo reconnect; 2–3 in a row is a
   real outage.
5. Alert channel: email (and push to phone if the provider supports it).

### What `/health` tells you

| Response | Meaning |
|----------|---------|
| `200` | Server up, MongoDB connected, startup complete |
| `503` | Starting up, or MongoDB disconnected (the disconnect guard returns 503 to avoid 500 storms) |
| Timeout / no response | Process down or Railway container not serving |

`/health` deliberately does **not** expose OpenAI status (security: don't leak
dependency state publicly).

---

## 3. What to watch, beyond up/down

| Signal | Where to look | Why |
|--------|---------------|-----|
| CI failing | GitHub Issues (`ci-failure` label) / Actions tab | Regression or broken test |
| App down / unhealthy | External uptime monitor on `/health` | Deploy crash, Mongo outage |
| OpenAI fallback unhealthy | `/stats` (admin) + logs (`isOpenaiHealthy`) | Ambiguous messages can't be parsed |
| Rate-limiting spikes | `/stats` + `rate_limits` collection | Possible abuse or a stuck loop |
| Daily activity trends | `node scripts/metrics-daily.js --days 7` | Growth / retention signal |
| Logs | Railway dashboard / `server.log` (local) | Errors, retries, OpenAI calls |

`/stats` (admin-only) already surfaces today's new/active users, messages,
confirmed transactions, cache hit rate, and system health — a good daily glance.

---

## 4. Review cadence (solo operator)

- **Daily (30s):** glance at the uptime monitor + any open `ci-failure` Issue.
- **Weekly:** run `scripts/metrics-daily.js --days 7`; review growth/retention.
- **Monthly:** review `RUNWAY.md` (financial runway) — see that file for triggers.

The goal: never again go weeks without noticing the platform is broken.