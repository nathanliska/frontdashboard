# Feature Decision Records

This directory contains Feature Decision Records (FDRs) for FrontDashboard. Each FDR documents one
feature: what it does behaviorally, what design decisions shaped it, and the rationale behind those
decisions.

FDRs are siblings of the [Architecture Decision Records](../adr/INDEX.md). ADRs cover cross-cutting
architectural choices; FDRs cover individual features and the design decisions specific to them. A
single feature may cite several ADRs; a single ADR may underpin several FDRs.

An FDR is **not** a code walkthrough, a file index, an implementation guide, or a changelog. It
describes the feature *today* — behavior plus rationale. For current-state prose across the whole
app, see [CONTEXT.md](../../CONTEXT.md); for how a specific change was executed, read the git
history; for open work, see [docs/TODO.md](../TODO.md).

Citations flow **one direction: FDR → ADR**. When you cite an ADR you don't edit the ADR back.

## Features

| # | Feature | Status | Last reviewed |
|---|---------|--------|---------------|
| [FDR-001](FDR-001-authentication-and-sessions.md) | Authentication & Sessions | Active | 2026-07-30 |
| [FDR-002](FDR-002-dashboards-and-layout.md) | Dashboards & Layout Editor | Active | 2026-07-26 |
| [FDR-003](FDR-003-widgets.md) | Widgets | Active | 2026-07-31 |
| [FDR-004](FDR-004-sharing-and-access.md) | Sharing & Access | Active | 2026-08-08 |
| [FDR-005](FDR-005-lists.md) | Lists | Active | 2026-07-30 |
| [FDR-006](FDR-006-calendar-and-events.md) | Calendar & Events | Active | 2026-08-08 |
| [FDR-007](FDR-007-notifications-and-activity.md) | Notifications & Activity Feed | Active | 2026-08-03 |
| [FDR-008](FDR-008-realtime-sse.md) | Real-Time Delivery (SSE) | Active | 2026-08-07 |
