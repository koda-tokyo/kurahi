---
summary: "CLI reference for `kurahi skills` (list/info/check/pin/verify) and skill eligibility"
read_when:
  - You want to see which skills are available and ready to run
  - You want to debug missing binaries/env/config for skills
title: "skills"
---

# `Kurahi skills`

Inspect skills (bundled + workspace + managed overrides) and see what’s eligible vs missing requirements.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- ClawHub installs: [ClawHub](/tools/clawhub)

## Commands

```bash
kurahi skills list
kurahi skills list --eligible
kurahi skills info <name>
kurahi skills check
kurahi skills verify            # skills and plugins against the supply-chain lock
kurahi skills pin <name>        # scan, then approve (pin) a skill; --all, --force, --agent, --json
```

Pinning and the load-time check are described in [Skill and plugin integrity](/security/skill-integrity).
