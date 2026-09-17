# EnotDesk server image — multi-stage, только сервер (клиент/Electron не нужен).
# Сборка: docker build -t enotdesk-server .   (обычно через compose.yaml, см. docker/README.md)

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Рантайм-зависимости сервера (ws, koffi); devDeps (electron и пр.) в образ не попадают.
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
# Серверные страницы (/downloads, /invite) читают общий словарь client/lib/i18n.mjs
COPY client/lib/i18n.mjs ./client/lib/i18n.mjs
COPY client/locales ./client/locales
# Оболочка запуска: вычисляет ENOT_PUBLIC_URL и TURN-креденшелы из DOMAIN/TURN_SECRET
COPY docker/enotdesk/entrypoint.sh /entrypoint.sh

# Данные (БД + каталог сборок) живут в volume'ах, смонтированных на /data
RUN mkdir -p /data/dist \
    && chown -R node:node /data /app
USER node

ENV ENOT_HOST=0.0.0.0 \
    ENOT_PORT=8080 \
    ENOT_DB=/data/enotdesk.db \
    ENOT_DIST_DIR=/data/dist
VOLUME ["/data"]
EXPOSE 8080

ENTRYPOINT ["sh", "/entrypoint.sh"]
CMD ["node", "server/main.mjs"]
