FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json vitest.config.ts ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm ci && npm run build
ENV NODE_ENV=production
CMD ["npm", "run", "engine"]
