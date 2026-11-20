# Deploying Pulse to Fly.io (owner-only)

One container: Expo web export + FastAPI, SQLite on a Fly volume in Sydney.

```bash
flyctl auth login
flyctl apps create pulse-hackathon          # once (deploy.sh does this if missing)
flyctl secrets set ANTHROPIC_API_KEY=... ANDROID_APK_URL=... -a pulse-hackathon
bash scripts/deploy.sh                       # creates volume, deploys, runs smoke test
```

Smoke test any instance: `bash scripts/smoke.sh https://pulse-hackathon.fly.dev`.

Local: `docker build -t pulse . && docker run -d -p 8000:8000 pulse && curl -fsS localhost:8000/api/health`.
Secrets are never stored in files. Machine stays on (`min_machines_running = 1`) so SQLite and autopilot keep running.
