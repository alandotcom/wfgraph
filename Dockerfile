FROM oven/bun:1.3.9 AS build

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json drizzle.config.ts ./
RUN bun install --frozen-lockfile

COPY drizzle ./drizzle
COPY src ./src
RUN BUN_COMPILE_TARGET=bun-linux-x64 bun run compile


FROM gcr.io/distroless/base-debian12:nonroot

WORKDIR /app
COPY --from=build /app/dist/ /app/
COPY --from=build /app/drizzle /app/drizzle

ENV NODE_ENV=production
ENV PORT=4017
EXPOSE 4017

ENTRYPOINT ["/app/server"]
