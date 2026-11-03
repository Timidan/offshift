FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
ENV OFFSHIFT_DB=/data/offshift.sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787

CMD ["node", "--no-warnings", "src/web.mjs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://localhost:'+(process.env.PORT || 8787)+'/how').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
