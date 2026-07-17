FROM node:22-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "runner/index.ts"]
