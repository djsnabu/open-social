FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_DIR=/app/data SHARP_IGNORE_GLOBAL_LIBVIPS=1
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/setup.js ./scripts/setup.js
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 4310
CMD ["node", "server/main.js"]
