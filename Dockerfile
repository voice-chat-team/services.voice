# ---- Stage 1: Build ----
FROM node:22.13-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

# ---- Stage 2: Production ----
FROM node:22.13-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

RUN chown -R node:node /app

USER node

CMD ["node", "dist/main"]
