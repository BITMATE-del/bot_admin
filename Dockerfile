FROM node:22-alpine
RUN apk add --no-cache font-noto-cjk font-dejavu
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY public ./public
EXPOSE 3000
CMD ["node","src/server.js"]
