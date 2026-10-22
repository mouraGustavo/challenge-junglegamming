FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN bun run build
USER bun
EXPOSE 3000 9100
CMD ["bun", "dist/src/main.js"]
