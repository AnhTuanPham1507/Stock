FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY public ./public
COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/server.mjs"]
