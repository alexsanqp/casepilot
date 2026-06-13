# Docker & Podman Containerization

CasePilot includes Docker and Podman support for easy deployment, CI/CD integration, and reproducible test environments.

## Image & Base Image

The CasePilot image is built from **`mcr.microsoft.com/playwright:v1.60.0-jammy`**:
- **Playwright version**: 1.60.0 (matches the version declared in `package.json`)
- **Chromium**: Preinstalled and ready to use (no `playwright install` needed in the container)
- **Base OS**: Ubuntu 22.04 LTS (Jammy) with all required system dependencies

The image is multi-stage to keep size efficient:
1. **Build stage**: Installs dependencies and builds all packages
2. **Runtime stage**: Contains only built artifacts, node modules (production), and Chromium

## Building the Image

### With `podman` (recommended on Linux, available on Windows with WSL2)

```bash
podman build -t casepilot:latest .
```

### With `docker` (standard Docker)

```bash
docker build -t casepilot:latest .
```

Both commands work identically; the Dockerfile is OCI-compatible.

## Running the Image

### 1. CLI Replay (Headless Test Run)

Run a recorded test suite headlessly and exit with the verdict:

```bash
podman run --rm \
  -v "$PWD/workspace:/work" \
  casepilot:latest run-all --workspace /work
```

- `--rm`: Remove the container after exit
- `-v "$PWD/workspace:/work"`: Mount your workspace directory into the container at `/work`
- Exit code: `0` if all cases passed, non-zero on failure (useful for CI)

**Run a single case**:
```bash
podman run --rm \
  -v "$PWD/workspace:/work" \
  casepilot:latest run my-case-name --workspace /work
```

**Record a case** (requires a provider configured in `casepilot.config.yaml`):
```bash
podman run --rm \
  -v "$PWD/workspace:/work" \
  casepilot:latest record my-case-name --workspace /work
```

### 2. REST Server

Run the server to expose the REST API on port 7700:

```bash
podman run --rm \
  -p 127.0.0.1:7700:7700 \
  -v "$PWD/workspace:/work" \
  casepilot serve --workspace /work --host 0.0.0.0
```

Inside the container the server binds `0.0.0.0:7700` (via `--host 0.0.0.0`) so
the published port can reach it. The default bind (`serve` with no `--host`) is
`127.0.0.1`, which a port mapping CANNOT reach — so `--host 0.0.0.0` is required
for containerized serving. The `-p 127.0.0.1:7700:7700` mapping publishes the
port ONLY to your host's loopback, so it reaches `http://127.0.0.1:7700` on the
host but is not exposed on the network.

> **Security — read before publishing the port.** The REST API is
> **UNAUTHENTICATED** and includes a filesystem-listing route
> (`GET /api/fs/dirs`). Binding `0.0.0.0` makes that API reachable through any
> published port; the CORS origin restriction only blocks browsers, not direct
> clients such as `curl`. Therefore **publish the port only to the host
> loopback** (`-p 127.0.0.1:7700:7700`) and never expose it on an untrusted
> network. The default `127.0.0.1` bind (no `--host`) stays loopback-only and is
> unreachable through a port mapping. Whenever possible, prefer the CLI runner
> (`run-all`) below, which needs no network at all.

API endpoints:
- `GET /status` — Server version and health
- `POST /runs/{project}/{case}` — Trigger a run
- `GET /runs/{project}/{case}` — List runs
- `GET /artifacts/{project}/{case}/video.mp4` — Latest proof video

### 3. Docker Compose (Recommended for Server)

For easier management, use the included `compose.yaml`:

```bash
podman compose up
```

This starts the server with the workspace pre-configured. Logs:
```bash
podman compose logs -f casepilot
```

Stop:
```bash
podman compose down
```

## Workspace Mounting

Your workspace (containing `casepilot.config.yaml`, `cases/`, `runs/`, `suites/`, `auth/`, etc.) must be mounted into the container at **`/work`** (or another path, but update `--workspace` accordingly).

### Permissions

The container runs as `pwuser` (non-root user in the Playwright base image). Ensure the mounted volume is readable and writable by this user:

**On Linux**:
```bash
# Make your workspace world-writable (permissive)
chmod -R 777 ./workspace

# Or, run the container with your user's UID/GID (more secure)
podman run --user $(id -u):$(id -g) \
  -v "$PWD/workspace:/work" \
  casepilot:latest run-all --workspace /work
```

**On Windows (WSL2 + Podman)**:
If your workspace is on the Windows filesystem mounted into WSL, ensure it's accessible. Typically, volume mounts just work; if permission errors occur, mount with `:z` or `:Z`:
```bash
podman run -v "$PWD/workspace:/work:z" casepilot:latest ...
```

### Secrets & Authentication

**Do NOT** bake your `auth/` directory or secrets into the image. Instead:

1. Mount your workspace (which includes `auth/`) at runtime:
   ```bash
   podman run -v "$PWD/workspace:/work" casepilot:latest ...
   ```

2. Pass provider credentials via environment variables if needed:
   ```bash
   podman run \
     -e OPENAI_API_KEY="sk-..." \
     -v "$PWD/workspace:/work" \
     casepilot:latest record my-case --workspace /work
   ```

3. Use CI/CD secrets (GitHub Actions `secrets.*`, GitLab `$CI_JOB_TOKEN`, etc.) to inject credentials at runtime.

The `.dockerignore` explicitly excludes `**/auth/`, ensuring secrets are never included in the build context.

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Test Suite

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Podman
        run: sudo apt-get install -y podman
      
      - name: Build CasePilot image
        run: podman build -t casepilot:ci .
      
      - name: Run test suite
        run: |
          podman run --rm \
            -v "$PWD/workspace:/work" \
            -e OPENAI_API_KEY="${{ secrets.OPENAI_API_KEY }}" \
            casepilot:ci run-all --workspace /work
      
      - name: Upload artifacts on failure
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: test-videos
          path: workspace/runs/*/video.mp4
```

### GitLab CI Example

```yaml
test:casepilot:
  image: registry.gitlab.com/myorg/casepilot:latest
  script:
    - casepilot run-all --workspace /work
  artifacts:
    paths:
      - workspace/runs/*/video.mp4
    when: on_failure
  variables:
    CASEPILOT_BASE_URL: "https://staging.example.com"
```

## Server Network Binding

**Default bind (`serve` with no `--host`)**: the server binds `127.0.0.1:7700`.
Inside a container this is loopback-only and **cannot be reached through a port
mapping** (`-p 7700:7700` will appear to connect on the host but get no
response), because the published port forwards to the container's `0.0.0.0`
interface, not its loopback. This default is correct for the no-networking CLI
runner and for running the server directly on a host.

**Container bind (`serve --host 0.0.0.0`)**: binds all interfaces inside the
container so a published port can reach it. Always pair it with a
loopback-scoped publish:

```bash
podman run --rm \
  -p 127.0.0.1:7700:7700 \
  -v "$PWD/workspace:/work" \
  casepilot serve --workspace /work --host 0.0.0.0
```

**Security**: the REST API is **unauthenticated** and includes a
filesystem-listing route (`GET /api/fs/dirs`); the CORS origin check only
restricts browsers, not direct `curl`-style clients. So:

- Publish the port only to the host loopback (`127.0.0.1:7700:7700`), never to
  `0.0.0.0` on an untrusted network.
- Avoid `--network host` and avoid binding `0.0.0.0` on a routable interface
  unless the network is fully trusted.

For most use cases, prefer the CLI runner (`run-all`) which needs no networking
at all.

## Image Size & Performance

- **Image size**: ~2.5 GB (includes Playwright, Chromium, Ubuntu base, and built Node modules)
- **Build time**: 5–10 minutes depending on network and CPU (first build pulls the Playwright base image)
- **Startup time**: <1 second for CLI commands, <2 seconds for the server

To reduce rebuild time during development, Docker layer caching is optimized:
1. `package.json` files are copied first (rarely change)
2. Dependencies are installed
3. Source code is copied and built

If you change only source code, the build skips dependency installation and uses cached layers.

## Chromium & Browser

Chromium is preinstalled in the base image and does not require:
- ~~`playwright install chromium`~~ (not needed in the container)
- ~~Additional browser downloads~~ (included in the base image)
- ~~Special system packages~~ (all OS deps are in the base image)

All replays and recordings use this Chromium instance. Videos are captured and available in `/work/runs/`.

## Troubleshooting

### "Cannot connect to Docker daemon"
- Ensure Docker or Podman is running: `podman --version` or `docker --version`
- On Windows, use WSL2 + Podman or Docker Desktop

### "Permission denied" when mounting workspace
- Ensure the mounted directory exists and is readable/writable
- On Linux: `chmod 777 workspace` or use `--user`
- On Windows: Ensure the path is accessible in WSL2

### "Chromium not found" / Playwright errors
- The Chromium is in the base image; no additional install is needed
- If an error persists, rebuild without cache: `podman build --no-cache -t casepilot:latest .`

### Container exits immediately
- Check logs: `podman run <image> <command>` (without `--rm`) and `podman logs <container>`
- Ensure `--workspace /work` is specified for `run-all` and `serve` commands

### Workspace changes not reflected in container
- Ensure you're using `-v` (volume) correctly: `-v /absolute/path/to/workspace:/work`
- Changes to mounted files inside the container are reflected immediately on the host

## Next Steps

- [Getting started](./getting-started.md) — Build and run your first case
- [CLI reference](./cli.md) — All commands and options
- [REST API](./rest-api.md) — Server endpoints and responses
