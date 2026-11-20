# Agent rules for Pulse (hackathon build, deadline Sat 21 Nov 2026 16:30 AEST)

- `docs/CONTRACT.md` is the source of truth. `apps/api/app/models.py`, `db.py`, `config.py`, `auth.py` and
  `main.py` belong to the lead: do not edit them; if your unit needs a change there, say so in your report.
- Touch only the files your brief names. Two units never edit the same file.
- Never commit or print a secret. `ANTHROPIC_API_KEY` comes from the environment only; tests run with it empty.
- Tests never call real external services: mock `anthropic`, use recorded fixtures for trend feeds.
- API: Python 3.13, FastAPI, stdlib sqlite3 via `app.db`, pydantic v2. Verifier: `cd apps/api && python -m pytest -q`
  and `ruff check app tests`.
- Mobile/web: Expo SDK 57, expo-router, TypeScript strict. Verifier: `cd apps/mobile && npx tsc --noEmit &&
  npx expo export --platform web`.
- Owner-only: credentials, deploys to Fly/EAS, spending the Anthropic key beyond tests, account changes.
