# GatherLocal workflow rules

- Read `AI_AGENT_PLAYBOOK.md` before any task involving app updates, feature
  development, overlay patches, contribution branches, or repository topology.
- Treat `CONTEXT.md` as the source of truth for repository authority.
- Keep this repository local-only unless the user explicitly chooses a private
  backup remote later. Never add or push a remote as part of sync development.
- Never read a live user-data path through code capable of writes. Tests and
  rehearsals use verified disposable copies only.
- Never place app source, credentials, user data, build output, or release
  artifacts here.
- Stop on the first replay conflict or failed validation. Do not auto-skip,
  auto-resolve, force-update, publish, deploy, or continue.
- Shell implementation must be portable to the macOS system toolchain. Tests
  must prove failure behavior, not only success behavior.
