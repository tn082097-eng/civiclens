# Freeze changes

- aeb6041: implementation and evidence committed, but the cached diff check flagged trailing whitespace inside raw command output and the initial patch snapshot. The command sequence incorrectly continued to commit after that check; this is not a verified candidate. No replay occurred there.
- Next commit: preserve the original raw evidence exactly inside `raw-evidence.json` (with SHA-256) and remove trailing whitespace from its readable copies. This changes evidence encoding only, not implementation/source/configuration. Decision: invalidate aeb6041 as the candidate because its whitespace gate failed; select the next commit before any replay. No stratum result is lost.
