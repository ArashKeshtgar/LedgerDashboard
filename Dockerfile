# The Resume Engine's rendering step (JobSearch/engine/build.py + validate.py)
# needs Python and LibreOffice at runtime, which a plain Node buildpack
# won't provide — hence a Dockerfile instead of relying on the platform's
# default Node detection.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    python3-pip \
    libreoffice \
    git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --break-system-packages python-docx pyyaml

WORKDIR /app

# npm ci: install exactly what the lockfiles pin, and fail if they drift.
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY client/package*.json ./client/
RUN cd client && npm ci

COPY client ./client
RUN cd client && npm run build && rm -rf node_modules

COPY server ./server

# JOBSEARCH_DATA_DIR must point at a mounted persistent volume with the
# real JobSearch/engine content (scripts, facts, ledger.csv, applications/)
# uploaded once — that data is intentionally never baked into this image,
# same reason it's not in the git repo. DASHBOARD_PASSWORD, SESSION_SECRET
# and ANTHROPIC_API_KEY are set as platform secrets, not here; the server
# refuses to start on 0.0.0.0 without the first two.
#
# NODE_ENV=production turns on Secure cookies and hides internal error
# details from API responses. The mount point is created owned by the
# unprivileged `node` user so a fresh volume is writable without root.
#
# git: every truth-bank save from the dashboard is a commit in the mounted
# engine/.git. That repo is owned by the host's deploy user, not this
# container's uid, so git's ownership check is turned off for it, and the
# commits get a fixed author.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    JOBSEARCH_DATA_DIR=/data/JobSearch \
    PYTHON=python3 \
    GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=* \
    GIT_AUTHOR_NAME="Ledger Dashboard" \
    GIT_AUTHOR_EMAIL=dashboard@ledger.local \
    GIT_COMMITTER_NAME="Ledger Dashboard" \
    GIT_COMMITTER_EMAIL=dashboard@ledger.local
RUN mkdir -p /data/JobSearch && chown -R node:node /data

USER node
EXPOSE 4310

CMD ["node", "server/index.js"]
