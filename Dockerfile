# The Resume Engine's rendering step (JobSearch/engine/build.py + validate.py)
# needs Python and LibreOffice at runtime, which a plain Node buildpack
# won't provide — hence a Dockerfile instead of relying on the platform's
# default Node detection.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    python3-pip \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --break-system-packages python-docx pyyaml

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev

COPY client/package*.json ./client/
RUN cd client && npm install

COPY client ./client
RUN cd client && npm run build

COPY server ./server

# JOBSEARCH_DATA_DIR must point at a mounted persistent volume with the
# real JobSearch/engine content (scripts, facts, ledger.csv, applications/)
# uploaded once — that data is intentionally never baked into this image,
# same reason it's not in the git repo. DASHBOARD_PASSWORD and
# ANTHROPIC_API_KEY are set as platform secrets, not here.
ENV JOBSEARCH_DATA_DIR=/data/JobSearch
EXPOSE 4310

CMD ["node", "server/index.js"]
