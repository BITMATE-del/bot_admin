FROM node:22-alpine
RUN apk add --no-cache font-noto-cjk font-noto-cjk-extra font-dejavu fontconfig
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY scripts/test-image-region.mjs ./scripts/test-image-region.mjs
COPY scripts/install-fonts.mjs ./scripts/install-fonts.mjs
RUN node ./scripts/install-fonts.mjs && fc-cache -f
RUN node ./scripts/test-image-region.mjs
EXPOSE 3000
CMD ["node","src/server.js"]
