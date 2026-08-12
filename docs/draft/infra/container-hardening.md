# Container hardening - verified against the real implementation

**Status: mostly already done.** This started as a proposal written without reading the backend
code. After actually reading `src/plugins/helper/DockerHelper.ts` and `DockerManager.ts` in the
`be` repo, nearly everything originally proposed here already exists - in most cases more
thoroughly than what was proposed. Rewritten to report what's real instead of a stale wishlist.

## Already implemented (`DockerHelper.createDockerCompose`)

- **Non-root**: `user: "1000:1000"` on the plugin container and its sidecar; the Dockerfile runs as
  the base image's built-in `node` user.
- **Read-only root filesystem**: `read_only: true`, with explicit `tmpfs` for `/tmp` and
  `/var/run` only.
- **All capabilities dropped**: `cap_drop: [ALL]`, plus `no-new-privileges:true` and
  `apparmor:docker-default`.
- **Resource limits**: memory/cpu `limits`+`reservations` per container.
- **Secret handling matches the SDK side exactly**: `.secrets.env` bind-mounted read-only at
  `/run/secrets/sdk_secret.env`, never via `environment:`/`env_file:` - the comment in
  `DockerHelper.ts` gives the identical reasoning `resolveSdkSecret()`'s comment in this SDK repo
  does (avoiding a `console.log(process.env)` leak). Per-container secret via
  `GrpcContainerSecretStore`, not a platform-wide static one.
- **Network egress, default case**: a plugin's network is `internal: true` **by default** (no
  route out at all, not even to the host) until an admin explicitly approves broader access
  (`isNetworkApproved`). This alone already blocks reaching a cloud metadata endpoint
  (`169.254.169.254`) for the common case - no explicit IP block needed when there's no route out
  in the first place.
- **SDK reachability without opening the plugin's own network**: a dedicated `sdk-gateway` sidecar
  (single-purpose `socat` TCP relay, its own minimal container) sits on both the plugin's network
  and a separate always-non-internal uplink network - it's the only thing that can reach the host,
  and it only ever forwards to one fixed destination. Even a fully compromised plugin container
  can't turn this into a general egress path. This is a more sophisticated answer to "how does the
  SDK call reach the host without giving the plugin real internet access" than what was originally
  proposed here (a plain egress allowlist).
- **Integrity check**: SHA-256 hash of the plugin's deployed files verified against a stored
  checksum before every scale-up (`calculateDirectoryHash`), blocking a tampered-on-disk deploy.

## One real, currently open gap: `GLOBAL_EGRESS_PROXY` isn't configured

For a plugin with `is_network_approved: true` (real internet access, not the internal-only
default), `manifest.json`'s `network_config.allowed_domains` is meant to be enforced by routing the
container's traffic through `GLOBAL_EGRESS_PROXY` (`HTTP_PROXY`/`HTTPS_PROXY` env vars set on the
container). **`DockerManager.ts` already self-flags this exact gap** (line ~709-713): if
`GLOBAL_EGRESS_PROXY` isn't set, `EGRESS_ALLOWED_DOMAINS` is written into the container's env as a
no-op - nothing actually enforces it, and the container gets full, unrestricted internet access
despite `network_config.allowed_domains` looking like it's scoping something.

Checked `.env` and `.env.staging` in this checkout: **`GLOBAL_EGRESS_PROXY` is not set in either.**
So today, any plugin with `is_network_approved: true` has full internet access, allowlist or not -
including to the cloud metadata endpoint, since nothing is proxying/filtering its traffic at all in
that case.

This is the one item worth actually raising with whoever owns network approval / the deploy
environment config - not a new design, just standing up the proxy the code already expects and
already warns about at runtime when it's missing.

## Not independently re-verified

Didn't check the *host's* own network/firewall setup (whether `169.254.169.254` is blackholed at
the host/VPC level regardless of container config), or whether `GLOBAL_EGRESS_PROXY` is configured
in a production env this checkout doesn't have `.env` files for. Worth confirming with whoever owns
that environment rather than assuming from this checkout's config alone.
