FROM node:22-alpine
WORKDIR /app
COPY package.json server.js integration-adapter.js integration-contract.js ./
EXPOSE 4100
CMD ["node", "server.js"]
