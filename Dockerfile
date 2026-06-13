# Multi-stage Docker build for CasePilot.
# Base image: mcr.microsoft.com/playwright:v1.60.0-jammy (Playwright 1.60.0, Chromium preinstalled, Ubuntu Jammy)
# This ensures Chromium and all OS dependencies are present without requiring `playwright install` in the container.

# ============================================================================
# Build Stage
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS builder

WORKDIR /app

# Copy package.json files first for better layer caching.
# Root package.json + lockfile
COPY package.json package-lock.json ./

# Each workspace package.json
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/

# Install dependencies. An optional build secret authenticates to a private npm
# registry (e.g. when package-lock.json resolves to a corporate Artifactory)
# without baking credentials into any image layer. A public-registry lockfile
# needs no secret. Provide it with:
#   podman build --secret id=npmrc,src=$HOME/.npmrc -t casepilot .
#   docker build --secret id=npmrc,src=$HOME/.npmrc -t casepilot .
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false npm ci

# Copy the rest of the source code
COPY . .

# Build all packages in dependency order
RUN npm run build

# ============================================================================
# Runtime Stage
# ============================================================================
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Set production environment variables
ENV CI=1
ENV NODE_ENV=production

# Copy built application from builder stage
COPY --from=builder /app /app

# Run as non-root user (pwuser exists in the Playwright base image).
# This user can read built artifacts and write to mounted volumes.
USER pwuser

# Default command: show help. Can be overridden with:
#   podman run <image> run-all --workspace /work
#   podman run <image> serve --workspace /work
ENTRYPOINT ["node", "/app/packages/cli/dist/bin.js"]
CMD ["--help"]
