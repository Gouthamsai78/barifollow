FROM node:24-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/barifollow.db

WORKDIR /app

# No npm dependencies — copy the app itself.
COPY package.json server.js index.html styles.css script.js ./
COPY src ./src
COPY public ./public
COPY assets ./assets

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
