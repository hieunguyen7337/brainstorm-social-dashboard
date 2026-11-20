# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web
WORKDIR /build/apps/mobile
COPY apps/mobile/ ./
ENV EXPO_PUBLIC_API_URL="" CI=1 EXPO_NO_TELEMETRY=1
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi \
 && npx expo export --platform web

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    WEB_DIST=/app/web DATABASE_PATH=/data/pulse.db
WORKDIR /app
COPY apps/api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/api/ /app/
COPY --from=web /build/apps/mobile/dist /app/web
# Runs as root: Fly mounts the /data volume root-owned, so a non-root user could not write SQLite there.
RUN mkdir -p /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=4).status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
