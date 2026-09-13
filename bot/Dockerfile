# Build context-nya ROOT repo, bukan bot/ — karena `bot` adalah paket di dalam
# pnpm workspace, dan lockfile yang otoritatif ada di root (lihat `importers:`
# di pnpm-lock.yaml). bot/pnpm-lock.yaml sudah jadi sisa dari sebelum workspace
# dibentuk; jangan dipakai, isinya bisa beda versi dari yang beneran terpasang.
#
# Jalankan dari root:  docker build -f bot/Dockerfile .
FROM node:24-slim

# Corepack yang nyiapin pnpm sesuai field `packageManager` di package.json root,
# jadi versinya persis sama dengan yang dipakai di lokal — bukan "pnpm terbaru"
# yang bisa beda resolusi dependensi.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Manifest dulu, kode belakangan: selama dependensi gak berubah, layer install
# yang mahal ini dipakai ulang dan rebuild cuma ngulang COPY kode.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY bot/package.json bot/package.json
RUN pnpm install --frozen-lockfile --filter teko-bot --prod

COPY bot/ bot/

# Turunkan hak akses setelah semua file masuk. `node` sudah ada di base image
# dengan uid 1000.
RUN chown -R node:node /app
USER node

WORKDIR /app/bot

# Cuma penanda buat pembaca; port yang beneran dipakai diambil dari
# WEBHOOK_PORT (lihat bot/src/config.js). Samakan dengan port yang diekspos
# di pengaturan service Northflank.
EXPOSE 8080

# `pnpm start` sengaja TIDAK dipakai: skrip itu pakai --env-file=.env.local,
# dan file itu memang tidak ikut ke image (lihat .dockerignore). Di Northflank
# env var diinject langsung ke proses.
CMD ["node", "src/index.js"]
