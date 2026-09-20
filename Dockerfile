FROM ghcr.io/foundry-rs/foundry:v1.5.1 AS contracts
WORKDIR /build
COPY foundry.toml ./
COPY contracts ./contracts
RUN forge build

FROM node:22.22.2-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY examples ./examples
COPY --from=contracts /build/out/RecordAnchor.sol/RecordAnchor.json ./out/RecordAnchor.sol/RecordAnchor.json
RUN mkdir -p /var/data && chown node:node /var/data
USER node
ENV NODE_ENV=production PORT=8080 DATA_DIR=/var/data OPERATOR_DIR=/var/data/operator
EXPOSE 8080
CMD ["node", "src/hosted/server.js"]
