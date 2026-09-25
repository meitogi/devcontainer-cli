# -----------------------------------------------
# Project DevContainer — slim layer over the published base image
# ghcr.io/meitogi/devcontainer-sandbox (repo: meitogi/devcontainer-sandbox).
# Compose pulls it — nothing is built locally except this thin layer.
#
# To bump Claude or the base: set BASE_IMAGE in .devcontainer/.env (tag
# scheme <base-version>-cc<claude-code-version>, published pairs listed in
# the base repo's cc-versions.json), then "Rebuild Container" in VS Code.
# The three published lines: 1.5.0-cc2.1.280 (default), 1.5.0-cc2.1.272,
# 1.5.0-cc2.1.220.
# -----------------------------------------------
ARG BASE_IMAGE=ghcr.io/meitogi/devcontainer-sandbox:1.5.0-cc2.1.280

# -----------------------------------------------
# Stage 1 — firewall bake (throwaway)
# -----------------------------------------------
# firewall/ carries domains.local.txt and policy.local.d/, which are gitignored
# and writable by anything running in the container. A `RUN rm` after a COPY
# would not help — the file still sits in the COPY layer. Layers built in a
# stage that nothing copies from never enter the final manifest, so the .local
# files are discarded rather than merely hidden. The bake also freezes the
# compiled ruleset into effective/, which boot installs verbatim.
FROM ${BASE_IMAGE} AS fw-bake

# 0 = hardened (default) : domains.local.txt and policy.local.d/ are NOT baked.
# 1 = convenience : they are. Set per developer through .env, never as a team
# default. Either way the bake logs which it did and how many hosts it costs.
ARG FIREWALL_ALLOW_LOCAL_AT_REBUILD=0

USER root
COPY firewall/ /tmp/fw-src/
RUN FIREWALL_ALLOW_LOCAL_AT_REBUILD="${FIREWALL_ALLOW_LOCAL_AT_REBUILD}" \
    /usr/local/bin/firewall-docker-setup.sh --src /tmp/fw-src --dest /out

# -----------------------------------------------
# Final image
# -----------------------------------------------
FROM ${BASE_IMAGE}

USER root

# /out already merges the base image's firewall content with the project
# overlay, so this single COPY is the whole configuration. Ownership and modes
# were set root:root / u=rwX,go=rX in the bake stage and COPY --from preserves
# them. The assertion catches a bake that silently produced nothing.
COPY --from=fw-bake /out/ /etc/devcontainer-firewall/
RUN test -s /etc/devcontainer-firewall/baked-at \
 && test -s /etc/devcontainer-firewall/effective/sources.sha256

# Project-specific layer (empty by default). Add `RUN apt-get install -y …`
# here for project deps that should NOT live in the shared base image — see
# the base repo's stacks/*.md for the documented PHP / Android / Capacitor
# blocks.

USER node
