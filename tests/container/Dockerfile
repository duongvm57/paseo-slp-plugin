# Container acceptance + disposable serve harness for paseo-slp.
#
# Base image: node:24-bookworm, pinned by multi-arch index digest
# (captured 2026-10-02 via `docker buildx imagetools inspect node:24-bookworm`).
# Node 24 satisfies the native TS floor (22.18 on 22.x, or >=23.6) and the managed runtime's
# Node line (v24.x), and supports direct .ts imports for the plugin entrypoint.
FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

# Pinned Paseo CLI/daemon. The version must satisfy the plugin manifest
# (plugin/paseo-plugin.json requirements.paseo: >=0.8.0); it is baked
# into the image and re-asserted inside the container at acceptance time.
ARG PASEO_CLI_VERSION=0.9.2
ENV SLP_PASEO_CLI_VERSION=${PASEO_CLI_VERSION}
RUN npm install --global --no-audit --no-fund "@getpaseo/cli@${PASEO_CLI_VERSION}" \
    && npm cache clean --force \
    && command -v paseo

WORKDIR /opt/slp-container
COPY entrypoint.sh accept.sh serve.sh ./
COPY lib/ lib/
COPY fixtures/ fixtures/
RUN chmod 0755 entrypoint.sh accept.sh serve.sh

ENTRYPOINT ["bash", "/opt/slp-container/entrypoint.sh"]
CMD ["accept"]
