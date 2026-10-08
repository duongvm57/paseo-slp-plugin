# Bridge startup reclaims only proven-dead lifecycle holders

- Status: Accepted
- Date: 2026-10-08
- Decided by: Human
- Source: Human assignment items A/C and independent review corrections
- Supersedes: 2026-09-29-desk-lock-recovery-is-operator-only.md

## Context

Unclean daemon exits leave the bridge lock behind, blocking the desk socket.

## Decision

The stable root is owned by one PID namespace; sharing across namespaces,
including other WSL distros or containers, is unsupported. ESRCH is relative
to that namespace. Only bridge startup may automatically reclaim its lock:
ESRCH or recorded boot/process-start mismatch proves the old instance dead.
Reuse serialized recovery, byte recheck, durable plugin audit and directory
fsync. Repository locks and operator recovery remain ESRCH-only.

## Consequences

Live/uncertain holders stay untouched; old-format live-PID locks need inspection.
Linux/WSL records kernel identity; other hosts use ESRCH. The plugin owns availability.
