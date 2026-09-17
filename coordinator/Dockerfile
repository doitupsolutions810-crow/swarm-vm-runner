FROM node:20-alpine
WORKDIR /app
COPY package.json server.js redis-lite.js ./
EXPOSE 4100
CMD ["node", "server.js"]
