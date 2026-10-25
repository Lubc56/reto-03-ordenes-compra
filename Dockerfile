FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
# El SAP simulado y los logs escriben en out/
RUN mkdir -p out && chown node:node /app /app/out
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
CMD ["npx", "tsx", "src/server.ts"]
