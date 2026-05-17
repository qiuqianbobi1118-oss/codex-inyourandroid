FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY public ./public
COPY src ./src
COPY .env.example ./.env.example
COPY README.md ./README.md
COPY DEVPLAN.md ./DEVPLAN.md

ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/server.js"]
