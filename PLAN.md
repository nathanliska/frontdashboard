# FrontDashboard - Project Plan

## 1. Product Vision

A self-hosted dashboard app that acts as a private household operating system. Shared where coordination matters, private where personal space matters, modular in layout and features.

---

## 2. Core Concepts

### 2.1 Visibility Model

Two scopes:

- **Private**: visible only to the owning user
- **Shared**: visible to all members of a group

A user can belong to multiple groups (e.g., "Family," "Roommates," "Book Club"). Every scoped record in the system carries these fields:

| Field              | Type     | Purpose                                       |
|--------------------|----------|-----------------------------------------------|
| `id`               | UUID     | Primary key                                   |
| `group_id`         | UUID FK  | Which group this belongs to (null for private) |
| `created_by`       | UUID FK  | User who created it                           |
| `updated_by`       | UUID FK  | User who last modified it                     |
| `visibility`       | ENUM     | `private` or `shared`                         |
| `created_at`       | DATETIME | Timestamp                                     |
| `updated_at`       | DATETIME | Timestamp                                     |
| `deleted_at`       | DATETIME | Soft-delete timestamp (nullable)              |

The database enforces the visibility invariant with a check constraint on every scoped table:
```
CHECK (
  (visibility = 'private' AND group_id IS NULL) OR
  (visibility = 'shared' AND group_id IS NOT NULL)
)
```

Selective sharing (share with specific members within a group) is deferred to a later version. When added, it will use a separate `record_access` join table rather than stuffing user IDs into JSON.

### 2.2 View Filtering

Every module view (lists, calendar, notes, etc.) provides filtering via two controls:

**Scope segments** (always visible):

| Segment        | Shows                                              |
|----------------|----------------------------------------------------|
| **Mine**       | Only the current user's private items              |
| **[Group name]** | Only that group's shared items                  |

There is no blended "All" view. The user always works in one explicit context at a time: their own private items, or a specific group's shared items. This keeps queries clean, permissions unambiguous, and the UI predictable.

**Group selection:**

- When 1-2 groups: the groups appear as inline segments next to "Mine" (e.g., Mine | Family | Roommates)
- When 3+ groups: groups collapse into a dropdown to keep the bar compact

Every item displays a scope badge (e.g., "Private," "Family," "Roommates") for visual clarity.

The active filter persists per-module in user preferences. Default depends on context: the private dashboard defaults to "Mine," a group dashboard defaults to that group, and a module page from the sidebar defaults to the user's most recently used scope for that module.

### 2.3 Dashboards

Two types of dashboards serve different purposes:

**Private dashboard**: the user's personal cockpit. Each user has exactly one private dashboard, created automatically at registration. They customize it by adding widgets from any scope -- personal todo list next to the Family grocery list next to the Roommates chore schedule. Only the owning user sees this layout.

Because private dashboards can mix widgets from multiple scopes, strong visual discipline is required to prevent accidental cross-scope actions. Each group is assigned a persistent scope color. Widget headers always display the source scope with its color. Inline actions on widgets clearly indicate which scope they affect. The scope indicator should be treated as an environment-level signal, not just metadata.

**Group dashboards**: each group has exactly one shared dashboard, created automatically when the group is created. It serves as a shared coordination surface -- best thought of as a shared status board that trusted contributors can help maintain. Accessed via a dedicated "Group Dashboards" page with a dropdown to switch between groups. Everyone in the group sees the same layout. Owners and admins can edit the layout by default. Individual members can be granted **dashboard editor** permission, allowing them to edit the layout and manage widgets without gaining broader admin powers (no invite, member removal, or group deletion access). Members without dashboard editor permission view only. The page loads the user's most recently viewed group by default (saved in preferences), falling back to the first group alphabetically for new users.

**Dashboard concurrency:** Each dashboard row has a `version` integer. When saving a layout change, the client sends the version it loaded. If the server's current version is higher (another editor made changes), the save is rejected and the client is prompted to reload. This prevents silent overwrites without requiring locks.

The data model stores group dashboard layouts as a single JSON blob per dashboard. To support per-member layout overrides in a future version, a `dashboard_user_layouts` join table can be added without changing the core schema.

### 2.4 Modules and Widget Interaction Model

Modules are domain features (lists, calendar, notes, tools, etc.) that provide two surfaces:

**Widgets** are interactive cards embedded on dashboards. They support three levels of interaction:

1. **Resize on the dashboard**: users drag a widget's resize handle to make it bigger or smaller on the grid. Widgets are size-aware and adapt their content to fit. A small list widget shows a few items and a completion count. A larger one shows more items with category grouping. This uses react-grid-layout's native resize behavior, with widgets observing their own container dimensions to adjust rendering. Each widget type defines minimum size constraints (e.g., list widget minimum 2x2, clock minimum 1x1) using react-grid-layout's `minW`/`minH` properties to prevent unusable micro-widgets.

2. **Quick inline actions**: users perform fast, frequent actions directly on the widget without leaving the dashboard. Check off a grocery item, add a new task, glance at today's calendar.

3. **Open full page**: a link icon in the widget header navigates to the full module page, pre-filtered to the widget's context. For example, opening a Family grocery list widget goes to the Lists page filtered to the Family group.

**Full pages** are standalone module views accessible from the sidebar or from a widget's link icon. They provide the full feature set with more screen real estate: sorting, search, bulk actions, detailed editing, the scope filter.

How this works per module:

**Lists**
- Widget: check/uncheck items, add new item via inline input, see completion progress. Resizing shows more or fewer items. Link icon opens list full page.
- Full page: create/delete lists, reorder items with drag, edit item details (due date, priority, category), archive lists, scope filter
- Each `list_type` (checklist, grocery, todo) gets its own UI treatment. Grocery lists show category/aisle grouping; todos show due date and priority; checklists keep it minimal. Irrelevant fields are hidden, not disabled, so the UI never feels like a partially-disabled super-form.

**Calendar** (v1.1)
- Widget: today's agenda or next few days, tap an event to see details in a popover. Resizing shows more days or event detail. Link icon opens calendar full page.
- Full page: day/week/month views, create/edit events with full form, recurrence settings, drag to reschedule

**Notes** (v1.2)
- Widget: preview of recent or pinned notes, tap to read. Resizing shows more note previews. Link icon opens notes full page.
- Full page: full editor with markdown, create/organize/search notes

Widgets share the same Zustand stores and API hooks as their full pages. Data stays in sync via SSE regardless of which surface the user is interacting with.

### 2.5 Widget Schema

Each widget on a dashboard is stored as a structured entry, not just a position in layout JSON. This separates layout concerns from widget configuration and enables versioned migration.

| Field          | Type     | Purpose                                           |
|----------------|----------|---------------------------------------------------|
| `widget_id`    | UUID     | Unique widget instance ID                         |
| `dashboard_id` | UUID FK  | Which dashboard this belongs to                   |
| `widget_type`  | STRING   | Type identifier (e.g., "list", "clock", "welcome")|
| `widget_version` | INT    | Schema version for this widget type               |
| `config`       | JSON     | Widget-specific settings (e.g., display options)  |
| `resource_type`| STRING   | Nullable. Type of bound record ("list", "note", "calendar_event") |
| `resource_id`  | UUID     | Nullable. ID of the bound record                  |

`resource_type` + `resource_id` is a polymorphic reference: it identifies the record a widget is bound to without requiring a separate FK column per module. In v1, the only value for `resource_type` is "list". As modules are added (calendar in v1.1, notes in v1.2), new resource types work without schema migration. Widgets that don't reference a record (clock, welcome) leave both fields null.

The react-grid-layout position/size data (x, y, w, h) is stored in the dashboard's `layout` JSON, keyed by `widget_id`. This means layout and widget config are independent: moving a widget doesn't touch its config, and updating config doesn't affect its position.

**Soft-fail rendering:** If a widget's `resource_id` points to a deleted record or a `widget_version` is outdated, the widget shows a placeholder with two actions: "Remove widget" and "Choose a different [list/note/etc.]." On group dashboards, users with dashboard edit access (owners, admins, and dashboard editors) see a subtle warning indicator on broken widgets so stale widgets don't linger unnoticed. Migration functions handle version upgrades when widget schemas evolve.

### 2.6 Notifications

Notifications use a **bell icon in the sidebar**, not a dashboard widget. This means they are always accessible regardless of which page the user is on -- dashboard, module page, tools, or settings.

The bell icon shows an unread count badge and opens a slide-out panel with recent inbox-worthy notifications. The panel links to a full notification history page.

#### Notification History Page

The history page has two tabs to keep concepts clear:

- **Notifications tab**: inbox-worthy items sent to you (invites, assignments, membership changes, reminders). This is "things that needed your attention."
- **Activity tab**: all logged events you have access to (item checks, list updates, dashboard changes). This is "what's been happening." Filterable by group and event type.

Both tabs pull from the same underlying tables but present different views. This prevents users from being confused about why some entries were never badge-worthy.

#### Notification Policy

Not every action creates a bell notification. Actions are split into two categories:

**Inbox-worthy** (shows badge, appears in bell panel):
- Group invites received, accepted, or declined
- Membership changes (someone joined or left a group)
- A list or item is assigned to you
- Reminders (v1.1)

**Activity-only** (logged in events table, visible in activity tab, no bell badge):
- Item checked/unchecked
- Item added/removed
- List created/renamed/archived
- Dashboard layout changed

**Core rules:**
- **Actor suppression**: you are never notified about your own actions
- **Coalescing**: rapid activity within a short time window (e.g., 5 minutes) is batched into a single entry ("4 items updated in Family Grocery" instead of 4 separate notifications)
- **Mute controls**: users can mute notifications per-group or per-list (future: per-item)

### 2.7 Departed User Handling

When a user leaves a group or deletes their account, their identity is preserved for context but their access is removed:

- Shared contributions remain in the group with the original `created_by` reference
- The UI displays departed users as "Former member (display_name)" where display_name is their name at departure time
- Assignments pointing to a departed user are flagged as unassigned
- Widgets referencing content they created are unaffected (the content belongs to the group)
- Activity history entries from departed users remain with attributed name

### 2.8 Navigation Structure

**Sidebar only.** The sidebar supports two states: collapsed (icons only) and expanded (icons + labels).

Sidebar layout from top to bottom:
- **App logo** (collapses to icon)
- **My Dashboard** (private dashboard page)
- **Group Dashboards** (dedicated page with group dropdown)
- **Modules** (Lists, Calendar, Notes, Tools, etc. -- each opens its full view with the scope filter)
- **Bottom section**: notification bell (with unread badge, opens slide-out panel), user avatar/menu (profile, preferences, group management, logout)

When creating new items, the default scope matches the current context. Creating a list from a group dashboard defaults to shared within that group. Creating from the private dashboard or a module's "Mine" view defaults to private.

### 2.9 Entities

| Entity       | Description                                                         |
|--------------|---------------------------------------------------------------------|
| **Group**    | A shared unit (e.g., "Family," "Roommates"). Contains members, shared dashboard, settings. |
| **User**     | Individual account. Has profile, preferences, private dashboard(s). |
| **Dashboard**| A configurable widget layout with version tracking. Either private (per-user) or shared (per-group). |
| **Widget**   | An interactive, versioned block on a dashboard with its own config. Soft-fails on broken references. |
| **Module**   | A domain feature: lists, calendar, notes, tools, etc.               |
| **Record**   | The underlying data: list, list item, event, note, etc.             |

---

## 3. Permissions & Roles

### 3.1 Group Roles

| Role       | Can invite | Can remove members | Can delete group | Group dashboard access      | Can manage shared containers |
|------------|------------|--------------------|--------------------|------------------------------|-------------------------------|
| **Owner**  | Yes        | Yes (except other owners) | Yes          | Edit (always)                | Yes                           |
| **Admin**  | Yes        | Yes (members only) | No                 | Edit (always)                | Yes                           |
| **Member** | No         | No                 | No                 | View by default; edit if granted dashboard editor permission | No |

- A group must always have at least one owner.
- Owners can promote members to admin or owner.
- Owners and admins can grant or revoke **dashboard editor** permission on individual members.
- Dashboard editor permission allows a member to edit the group dashboard layout and manage widgets (add, remove, configure, rebind, move, resize). It does not grant any other admin powers: no invite generation, no member removal, no group deletion, no shared-container management (rename/archive/delete lists, etc.).
- Private records are only accessible by the owning user -- no admin/owner override.

### 3.2 Action-Type Permissions

Permissions are split by action class, not by a blanket "can edit" flag:

| Action class         | Who can do it                              | Examples                                      |
|----------------------|--------------------------------------------|-----------------------------------------------|
| **Contribute**       | Any group member                           | Add items, check/uncheck items, reorder items  |
| **Edit content**     | Item creator + admin + owner               | Edit an item's text, change due date/priority   |
| **Manage container** | Container creator + admin + owner          | Rename list, archive list, delete list          |
| **Administer scope** | Admin + owner                              | Change sharing settings, transfer ownership     |
| **View dashboard**   | Any group member                           | See the group dashboard and its widgets         |
| **Edit dashboard**   | Owner + admin + dashboard editor           | Move/resize widgets on the grid                 |
| **Manage dashboard widgets** | Owner + admin + dashboard editor   | Add, remove, configure, rebind widgets          |

Dashboard permissions are separate from the other action classes. A member with dashboard editor permission can edit layout and manage widgets but cannot rename lists, remove members, or perform any administer-scope action. This allows trusted contributors to maintain the group's shared dashboard without granting broad admin powers.

For v1.0 lists specifically:
- Any member can add items, check/uncheck, and reorder
- Item text can be edited by the item's creator, group admins, or group owners
- List-level operations (rename, archive, delete) require being the list's creator, a group admin, or a group owner
- Items can be deleted by the item's creator, group admins, or group owners

This model extends naturally to future modules (calendar events, notes, documents) without requiring a redesign.

### 3.3 Membership Changes

When a user leaves a group:

- Their shared contributions (list items, calendar events, etc.) remain -- they belong to the group.
- `created_by` still references the departed user for audit, but the user loses access.
- Their private data is unaffected (it belongs to the user, not the group).
- The group dashboard is unaffected.
- See section 2.7 for departed user display rules.

When a user deletes their account:

- Private data is soft-deleted after a grace period (or exported if requested).
- Shared contributions remain in their groups with the original `created_by` reference.
- Display name is preserved for attribution (see section 2.7).

---

## 4. Version Roadmap

### v1.0 - Foundation + Dashboards + Lists

The core loop: auth, groups, customizable dashboards, and lists with real-time sync.

**Auth & Groups**
- Local account registration/login (email + password)
- JWT auth with HttpOnly cookies + CSRF double-submit protection
- Group creation, invite system (reusable codes with configurable expiry and max uses)
- Support for multiple group memberships per user
- Owner / Admin / Member roles with action-type permissions
- User profile and preferences
- Login rate limiting, invite redemption rate limiting

**Dashboards**
- Drag-and-drop, resizable widget grid (react-grid-layout)
- Private dashboard with per-user layout persistence and cross-scope visual discipline
- Group dashboards page with group dropdown, single shared layout per group
- Group dashboard editing: owners/admins by default, members with dashboard editor permission
- Dashboard editor grant/revoke in group settings (owners and admins only)
- Dashboard version conflict detection for concurrent edits
- Widget catalog: list widget, clock widget, welcome/status widget
- Structured widget schema (type, version, config, resource_type/resource_id) with soft-fail rendering
- Broken widget actions: remove widget, rebind to different record (visible to editors)
- Add/remove/configure widgets
- Widgets are resizable (size-aware content adapts to dimensions), support inline quick actions, and link out to full module pages

**Lists Module**
- Unified list model with `list_type` field controlling display:
  - `checklist` - simple checkable items (packing list, to-do)
  - `grocery` - checkable items with optional category/aisle grouping
  - `todo` - checkable items with optional due date, priority, and member assignment
- Each list_type gets tailored UI that hides irrelevant fields
- List operations: create, rename, archive, delete (container-level permissions)
- Item operations: add, check/uncheck, reorder, assign (contribute-level), edit text, delete (creator/admin/owner)
- Each list is scoped private or shared (with a specific group)
- Default scope based on context (creating from a group dashboard = shared with that group)
- Scope filter: Mine + per-group (no blended view)
- List widget: check/uncheck items, add new item inline, completion progress, size-aware content, link to full page
- List full page: all list operations, drag reorder, item detail editing, scope filter

**Real-Time Sync**
- SSE (Server-Sent Events) for server -> client push
- Single multiplexed SSE connection per user, events tagged with group_id
- Client actions go via REST, server broadcasts changes via SSE
- When user 1 checks a grocery item, user 2 sees it immediately on both widget and full page
- Widget and full page views stay in sync through shared Zustand stores
- Defined event types (list.created, list.item.checked, membership.added, etc.)
- Reconnect with `Last-Event-ID` replay; full refetch on stale gap

**Data consistency rules for Zustand:**
- REST is the authoritative source for initial data fetch
- SSE events update stores incrementally; each event carries entity_version
- On reconnect, client sends Last-Event-ID; server replays missed events or triggers resync
- Duplicate events are ignored (idempotent by event_id)
- Optimistic updates are minimal in v1; server truth is preferred
- Full store refetch is triggered on resync events or after prolonged disconnection

**Notifications**
- Bell icon in sidebar with unread count badge
- Slide-out panel with recent inbox-worthy notifications
- Inbox-worthy vs activity-only split (see section 2.6)
- Actor suppression and event coalescing
- Stored in DB, delivered via SSE
- Notifications respect visibility -- private actions don't leak
- Full notification history page with Notifications tab and Activity tab

**Invite System**
- Reusable invite codes with configurable expiry (default 7 days) and max uses (default 10)
- Only owners and admins can generate/revoke codes
- Admin view showing active invites with remaining uses
- New members join as "member" role (promotion requires explicit action)
- Possession of code is sufficient to join (no email-match requirement)
- Rate limiting on invite redemption

### v1.1 - Calendar + Reminders

- Calendar module with day/week/month views
- Events with date, time, recurrence, description
- Events scoped private or shared (per group)
- Action-type permissions applied to calendar events
- Reminders (one-time and recurring) with in-app notification (inbox-worthy)
- Calendar widget: today's agenda, tap event for details popover, size-aware, link to full page
- Calendar full page: all views, full event form, recurrence, drag to reschedule
- "Today" agenda widget for dashboards

### v1.2 - Notes + Documents

- Notes module: quick text notes, markdown support
- Notes scoped private or shared (per group)
- Action-type permissions applied to notes
- Document vault: upload and organize files (store files on disk/volume, metadata in DB)
- File security: allowed MIME types, max file size, filename normalization, path traversal prevention, authorized access paths, content-type enforcement
- File previews render through a constrained viewer route (auth-gated, no raw file URL exposure)
- File preview for common types (images, PDFs)
- Notes widget: recent/pinned note previews, tap to read, size-aware, link to full page
- Notes full page: full editor, create/organize/search
- Recent documents widget for dashboards

### v1.3 - Recurring Tasks + Polish

- Recurring chore assignments with rotation (e.g., take out trash every Tuesday, alternating between users)
- Task assignment to group members
- Dashboard templates (starter layouts for common setups)
- Mobile-responsive layout improvements
- Per-member group dashboard layout overrides
- Refinements based on real usage

### v1.4 - Tools

A collection of standalone client-side utilities accessible from the sidebar. These are stateless (no database required) and run entirely in the browser.

- **PDF tools**: merge, split, reorder pages, compress
- **Image tools**: resize, compress, convert between formats
- **JSON formatter/validator**: with support for other data formats (YAML, XML, TOML)
- **Diff checker**: compare two text inputs side-by-side
- **Case converter**: camelCase, snake_case, UPPER, lower, Title Case, etc.
- **Text tools**: word/character count, find and replace, encode/decode (Base64, URL)

These tools are lightweight and self-contained. They can be added incrementally and do not depend on other modules.

### Future (v2+)

- External calendar sync (CalDAV / Google Calendar)
- Finance watchlists / manual account snapshots
- News and weather widgets
- Meal planning + pantry tracking
- OAuth/SSO login
- Selective sharing (share with specific members within a group)
- AI summaries and suggestions
- Push notifications (service worker + optional relay)
- Email notifications (SMTP config)
- Global command/search bar
- Quick add from anywhere

---

## 5. Tech Stack

### 5.1 Backend

| Component        | Choice                    | Rationale                                                    |
|------------------|---------------------------|--------------------------------------------------------------|
| Language         | **Python 3.12+**          | Familiarity; strong async ecosystem                          |
| Framework        | **FastAPI**               | Async-first, auto OpenAPI docs, Pydantic validation          |
| Package manager  | **uv**                    | Fast, modern Python package/project management               |
| ORM              | **SQLAlchemy 2.0** (async)| Mature, async support, works with Alembic migrations         |
| Migrations       | **Alembic**               | Standard for SQLAlchemy schema migrations                    |
| Database         | **PostgreSQL 16**         | Full-featured, runs great in Docker, concurrent-access safe  |
| Auth             | **python-jose + passlib** | JWT creation/validation + Argon2 password hashing            |
| SSE              | **sse-starlette**         | Clean SSE support for FastAPI/Starlette                      |
| ASGI server      | **Uvicorn**               | High-performance async server                                |

### 5.2 Frontend

| Component        | Choice                    | Rationale                                                    |
|------------------|---------------------------|--------------------------------------------------------------|
| Framework        | **React 18+** (Vite)      | Familiarity; large ecosystem                                 |
| Language         | **TypeScript**            | Type safety across the frontend                              |
| Styling          | **Tailwind CSS**          | Utility-first, fast iteration                                |
| Dashboard grid   | **react-grid-layout**     | Drag-and-drop + resize, responsive breakpoints, per-user layout persistence, actively maintained |
| State management | **Zustand**               | Lightweight client state; SSE handles data freshness, no need for a server-state cache layer |
| Routing          | **React Router v6+**      | Standard SPA routing                                         |
| SSE client       | **EventSource API** (native) | Built into browsers, auto-reconnect                       |
| HTTP client      | **Axios** or **fetch**    | REST calls to backend                                        |

### 5.3 Infrastructure

| Component        | Choice                    | Rationale                                                    |
|------------------|---------------------------|--------------------------------------------------------------|
| Containerization | **Docker + Docker Compose** | Three services: frontend, backend, database                |
| Reverse proxy    | **Caddy**                 | Automatic HTTPS, simple config, works for local/self-host/cloud |
| Database         | **PostgreSQL** (Docker)   | Persistent volume for data                                   |
| File storage     | **Local volume** (v1)     | Mounted Docker volume; abstracted behind a storage service for future S3/cloud migration |

### 5.4 Real-Time: SSE

**Connection strategy:** Single multiplexed SSE connection per user. The server filters events by the user's group memberships and tags each event with a `group_id`. The client routes events to the appropriate Zustand store based on the tag. This avoids opening N connections for N groups and scales cleanly regardless of how many groups a user belongs to.

**Event model:** Every SSE event has a defined type, enabling the client to handle events precisely:

- `list.created`, `list.updated`, `list.archived`, `list.deleted`
- `list.item.created`, `list.item.updated`, `list.item.checked`, `list.item.assigned`, `list.item.deleted`
- `membership.added`, `membership.removed`, `membership.role_changed`
- `notification.created`
- `dashboard.layout_changed`, `dashboard.widget_added`, `dashboard.widget_removed`

Each event carries: `event_id` (incrementing), `event_type`, `group_id` (nullable), `entity_id`, `entity_version`, `changed_at`, `changed_by`, and `payload` (the changed data).

**Reconnect behavior:** The native EventSource API sends `Last-Event-ID` on reconnect. The server replays all events since that ID. If the gap exceeds a threshold (e.g., 1000 events or 1 hour), the server sends a `resync` event and the client does a full refetch of its active stores. This prevents unbounded replay while keeping the common case (brief disconnects) seamless.

**Rationale for SSE over WebSocket:**
- The data flow is primarily server -> client (broadcast changes to connected group members)
- Client -> server actions go through normal REST endpoints
- SSE is simpler: no connection upgrade, works through HTTP proxies and Caddy without special config, auto-reconnects on disconnect
- Performance difference is negligible (approximately 3ms latency difference at scale)
- If future features need true bidirectional streaming (e.g., real-time collaborative editing), WebSocket can be added alongside SSE for those specific endpoints

### 5.5 Authentication Architecture

**JWT with HttpOnly cookies + CSRF double-submit pattern.**

Flow:
1. User registers with email + password (password hashed with Argon2 via passlib)
2. User logs in -> server issues:
   - Short-lived **access token** (15 min) as HttpOnly, Secure, SameSite=Lax cookie
   - Longer-lived **refresh token** (7 days) as HttpOnly, Secure, SameSite=Lax cookie
   - **CSRF token** as a readable cookie (double-submit pattern)
3. Frontend includes CSRF token in headers on mutation requests (POST/PUT/PATCH/DELETE)
4. Before access token expires, frontend calls `/auth/refresh` -> server validates refresh token, issues new access token
5. Logout clears all cookies and invalidates the refresh token server-side

Security properties:
- HttpOnly cookies prevent XSS from stealing tokens
- CSRF double-submit pattern prevents cross-site request forgery
- Short-lived access tokens limit the window of compromise
- Refresh tokens are stored in DB and can be revoked
- SameSite=Lax prevents most CSRF vectors natively

**Abuse prevention:**
- Login rate limiting (per IP and per account)
- Account creation rate limiting
- Invite redemption rate limiting
- CSRF failure logging
- Lockout after repeated auth failures (temporary, with backoff)
- Optional email verification path (not mandatory for self-hosting)

### 5.6 Security Headers

Caddy (or app middleware) should set the following on all responses:

- `Content-Security-Policy`: restrict script sources, frame ancestors
- `Strict-Transport-Security`: enforce HTTPS in production
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- Strict cookie scoping (path, domain, Secure flag)
- CORS policy per environment

### 5.7 Backup Strategy

For a self-hosted household app, data loss is a practical risk:

- **Database**: pg_dump on a cron schedule to a separate volume or external path. Document the restore process.
- **Uploaded files**: volume-level backup (rsync or snapshot) alongside DB backup.
- **Secrets**: document which environment variables must be preserved (SECRET_KEY, DB credentials) and warn that losing SECRET_KEY invalidates all active sessions.
- **Export**: users can export their private data (lists, notes) as JSON. Group owners can export group data.

---

## 6. Data Model (Core v1 Tables)

```
-- users
   id (UUID PK), email (UNIQUE), password_hash, display_name,
   preferences (JSON), created_at, updated_at, deleted_at

-- groups
   id (UUID PK), name, created_by FK, settings (JSON),
   created_at, updated_at, deleted_at

-- group_members
   id (UUID PK), group_id FK, user_id FK, role (owner/admin/member),
   dashboard_role (viewer/editor, default 'viewer'),
   joined_at, left_at (nullable)
   UNIQUE(group_id, user_id) WHERE left_at IS NULL

   Note on dashboard_role: only meaningful when `role` is 'member'.
   Owners and admins always have full dashboard edit access regardless
   of this field. Permission check:
   can_edit_dashboard = (role IN ('owner', 'admin')) OR (dashboard_role = 'editor')
   Chosen over a separate permissions table because v1 only has one
   grantable capability. If future versions need more fine-grained
   member capabilities, this field can be migrated to a capabilities
   table without breaking the group_members schema.

   Note on left_at: when a user leaves or is removed, `left_at` is
   set rather than deleting the row. This preserves membership history
   for audit and allows clean display of departed users. The partial
   unique index ensures a user can only have one active membership per
   group while allowing historical rows. If a user rejoins, a new row
   is created.

-- invites
   id (UUID PK), group_id FK, code (UNIQUE), created_by FK,
   expires_at, revoked (bool), max_uses (default 10), use_count,
   created_at
   INDEX(code, revoked, expires_at)

   Note: all invites grant the 'member' role on join. If future
   versions need role-scoped invites, a `role_on_join` column can
   be added without migration complexity.

-- dashboards
   id (UUID PK), group_id FK (null for private), created_by FK, name,
   visibility (private/shared), version (int, default 1),
   layout (JSON - react-grid-layout position data keyed by widget_id),
   created_at, updated_at
   CHECK ((visibility = 'private' AND group_id IS NULL) OR
          (visibility = 'shared' AND group_id IS NOT NULL))
   UNIQUE(created_by) WHERE visibility = 'private'
   UNIQUE(group_id) WHERE visibility = 'shared'

   Note on cardinality: v1 enforces exactly one private dashboard per
   user and one shared dashboard per group via partial unique indexes.
   Private dashboards are created at user registration; group dashboards
   are created at group creation. The `name` field is present but unused
   in v1 UI. When multiple dashboards per user/group are supported in a
   future version, the partial unique indexes are simply dropped.

-- dashboard_widgets
   id (UUID PK), dashboard_id FK, widget_type (string),
   widget_version (int), config (JSON),
   resource_type (string, nullable), resource_id (UUID, nullable),
   created_at, updated_at
   INDEX(dashboard_id)

   Note on resource binding: `resource_type` + `resource_id` is a
   polymorphic reference. In v1, the only resource_type is 'list'.
   Future modules add new types ('calendar_event', 'note') without
   schema changes. A single generic UUID FK was rejected because it
   cannot have a real foreign key constraint across multiple tables.
   Widgets with no bound record (clock, welcome) leave both fields null.

-- lists
   id (UUID PK), group_id FK (null for private), created_by FK, updated_by FK,
   name, list_type (checklist/grocery/todo), visibility (private/shared),
   sort_order, archived (bool), created_at, updated_at, deleted_at
   CHECK ((visibility = 'private' AND group_id IS NULL) OR
          (visibility = 'shared' AND group_id IS NOT NULL))
   INDEX(created_by, visibility, deleted_at)
   INDEX(group_id, visibility, archived, deleted_at)

-- list_items
   id (UUID PK), list_id FK, text, checked (bool), sort_order,
   due_date (nullable), priority (nullable),
   category (nullable - for grocery aisle grouping),
   assigned_to FK (nullable - group member assignment),
   created_by FK, updated_by FK, created_at, updated_at, deleted_at
   INDEX(list_id, sort_order, deleted_at)
   INDEX(assigned_to, checked, deleted_at)

-- activity_events
   id (UUID PK), event_id (BIGSERIAL, incrementing), event_type (string),
   group_id FK (nullable), actor_id FK, actor_display_name (string),
   entity_type (string), entity_id (UUID),
   entity_version (int), payload (JSON), created_at
   INDEX(event_id)
   INDEX(group_id, created_at)
   INDEX(actor_id, created_at)

   Note on actor_display_name: snapshot of the actor's display name at
   the time of the event. This ensures activity history remains readable
   if the user later renames themselves, leaves the group, or deletes
   their account. The `actor_id` FK is preserved for linking to user
   records when they still exist.

-- notifications
   id (UUID PK), group_id FK (nullable), user_id FK (recipient),
   activity_event_id FK (nullable - links to activity_events),
   type (string), title, body,
   reference_type, reference_id, read_at (datetime, nullable),
   created_at
   INDEX(user_id, read_at, created_at)

   Note on read_at: null = unread, timestamp = when the user read it.
   Functionally equivalent to a boolean flag but provides more useful
   data for analytics, debugging, and future features (e.g., "unread
   for more than 24 hours" logic).

-- refresh_tokens
   id (UUID PK), user_id FK, token_hash, expires_at, revoked (bool),
   device_name (nullable), ip_hash (nullable), user_agent_hash (nullable),
   created_at, last_used_at
   INDEX(user_id, revoked, expires_at)
```

**Private records** have `group_id = NULL` and `visibility = 'private'`.
**Shared records** have `group_id` set to the owning group and `visibility = 'shared'`.

**Why NULL for private group_id:** The `visibility` field is the real discriminator in every query. Private records are fetched with `WHERE visibility = 'private' AND created_by = :user_id`. Shared records are fetched with `WHERE group_id = :id AND visibility = 'shared'`. No query ever compares `group_id` to NULL directly, so the NULL does not introduce awkward IS NULL conditions. The alternative -- creating a synthetic "personal group" per user -- would add rows to the groups table, require special-case logic to hide personal groups from the UI, and conflate "group" to mean two different things. The database check constraint enforces correctness at the schema level.

**Layout persistence:** In v1, each user has exactly one private dashboard and each group has exactly one shared dashboard, enforced by partial unique indexes. Private dashboards are created at user registration; group dashboards are created at group creation. Widget instances are stored in `dashboard_widgets`, linked by `dashboard_id`. The layout JSON contains only position/size data keyed by widget_id. In v1, all group members see the same layout. For future per-member overrides, a `dashboard_user_layouts` join table (user_id, dashboard_id, layout JSON) can be added without schema changes to existing tables. To support multiple dashboards per user or group in a future version, the partial unique indexes on `dashboards` are simply dropped.

---

## 7. Project Structure

```
frontdashboard/
├── docker-compose.yml
├── Caddyfile
├── .env.example
├── README.md
│
├── backend/
│   ├── pyproject.toml          # uv project config
│   ├── uv.lock
│   ├── Dockerfile
│   ├── alembic/                # DB migrations
│   │   ├── alembic.ini
│   │   └── versions/
│   ├── app/
│   │   ├── main.py             # FastAPI app entry
│   │   ├── config.py           # Environment-based settings
│   │   ├── database.py         # Async SQLAlchemy engine/session
│   │   ├── models/             # SQLAlchemy models
│   │   │   ├── user.py
│   │   │   ├── group.py
│   │   │   ├── invite.py
│   │   │   ├── dashboard.py
│   │   │   ├── widget.py
│   │   │   ├── list.py
│   │   │   ├── activity.py
│   │   │   └── notification.py
│   │   ├── schemas/            # Pydantic request/response schemas
│   │   ├── routers/            # API route handlers
│   │   │   ├── auth.py
│   │   │   ├── groups.py
│   │   │   ├── invites.py
│   │   │   ├── dashboards.py
│   │   │   ├── lists.py
│   │   │   └── notifications.py
│   │   ├── services/           # Business logic layer
│   │   │   ├── permissions.py  # Action-type permission checks
│   │   │   └── notifications.py # Notification policy, coalescing
│   │   ├── sse/                # SSE event broadcasting
│   │   │   ├── manager.py      # Connection manager (multiplexed, per-user)
│   │   │   └── events.py       # Event types, serialization, replay
│   │   ├── auth/               # JWT, password hashing, CSRF, rate limiting
│   │   └── middleware/         # CORS, security headers, error handling
│   └── tests/
│
├── frontend/
│   ├── package.json
│   ├── Dockerfile
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.js
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/                # API client + hooks
│   │   ├── components/
│   │   │   ├── layout/         # Sidebar (logo, nav, bell, user menu), page shell
│   │   │   ├── dashboard/      # Grid, widget container, widget catalog
│   │   │   ├── widgets/        # Widget type implementations (list, clock, welcome)
│   │   │   ├── lists/          # List full page, item rows, forms
│   │   │   ├── notifications/  # Bell icon, slide-out panel, history page
│   │   │   ├── tools/          # PDF, image, JSON, diff, text utilities
│   │   │   └── common/         # Buttons, modals, inputs, scope filter, scope colors
│   │   ├── pages/              # Route-level page components
│   │   ├── hooks/              # Custom hooks (useSSE, useAuth, useScopeFilter, etc.)
│   │   ├── stores/             # Zustand stores (shared between widgets and full pages)
│   │   ├── types/              # TypeScript type definitions
│   │   └── utils/
│   └── tests/
│
└── docs/                       # Architecture decisions, API docs
```

---

## 8. Docker Compose Architecture

```yaml
# Simplified overview
services:
  caddy:
    image: caddy:2
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile

  frontend:
    build: ./frontend
    # Served via Caddy in production; Vite dev server in development

  backend:
    build: ./backend
    environment:
      - DATABASE_URL=postgresql+asyncpg://user:pass@db:5432/frontdashboard
      - SECRET_KEY=${SECRET_KEY}
      - CORS_ORIGINS=http://localhost:3000
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=frontdashboard

volumes:
  pgdata:
```

Caddy handles:
- Reverse proxying `/api/*` -> backend, everything else -> frontend
- Automatic HTTPS in production (with real domain)
- HTTP for local development
- SSE passthrough (`/api/sse/*`) with buffering disabled
- Security headers (CSP, HSTS, X-Frame-Options, etc.)

---

## 9. Mobile Considerations

Mobile is not a primary design target for v1, but the architecture accounts for it:

- **react-grid-layout supports responsive breakpoints**: define different column counts for `lg`, `md`, `sm`, `xs` screen sizes. Widgets can stack to single-column on mobile.
- **Tailwind CSS is mobile-first**: all styling will use responsive utilities.
- **Lists are naturally mobile-friendly**: a list of checkable items renders well on any screen.
- **SSE works on mobile browsers**: no special handling needed.
- **API is REST**: a native mobile app could consume the same API later.
- **Sidebar collapses**: on small screens, the sidebar collapses to icons or becomes a hamburger menu.

Mobile should prioritize consumption over editing: quick lists, notifications, and agenda views rather than full dashboard layout editing. Dashboard layout editing should be desktop/tablet only.

For v1.3, dedicated mobile layout refinements (touch-friendly interactions, bottom navigation on small screens).

---

## 10. Notification Strategy by Version

| Version | Channel       | Mechanism                                       |
|---------|---------------|-------------------------------------------------|
| v1.0    | In-app only   | Bell icon + slide-out panel, SSE delivery       |
| v1.1    | In-app + badge| Calendar reminders trigger inbox-worthy notifications |
| v1.3    | In-app + email (optional) | SMTP config in settings for email delivery of reminders |
| v2+     | Push notifications | Service worker + optional push relay for mobile/desktop |

---

## 11. Decided (Formerly Open)

1. **List item assignment**: included in v1.0. Optional `assigned_to` FK on list_items. Assigning an item triggers an inbox-worthy notification. Only shown in the UI for todo-type lists. Permission to assign follows contribute-level access (any group member can assign).

2. **Group size**: flexible group size from day one (no artificial cap). Children/limited-access roles deferred to v2+.

3. **Widget catalog for v1.0**: list widget (interactive), clock widget, and welcome/status widget. Each widget type defines minimum size constraints. Add more widget types as modules land in later versions.

---

## 12. Development Setup Standards

From the first commit:

**Git configuration**
- Initialize monorepo with `backend/` and `frontend/` workspaces
- Pre-commit hooks via `pre-commit` (backend) and Husky (frontend): lint + format on every commit
- Pre-push hooks: run unit tests before push is allowed
- `.gitignore` covering Python bytecode, node_modules, .env, build artifacts, IDE files, Docker volumes
- Conventional commits enforced (e.g., `feat:`, `fix:`, `chore:`, `docs:`) via commitlint or hook script
- PR template with checklist: tests pass, migrations included if schema changed, docs updated, no secrets committed
- Issue templates: bug report, feature request

**Backend**
- Ruff for linting and formatting (single tool, fast)
- pytest for tests
- pyproject.toml as single config source for Ruff, pytest, and project metadata

**Frontend**
- ESLint + Prettier for linting and formatting
- Vitest for tests
- Consistent import ordering via ESLint plugin

**Shared**
- `.env.example` with all required environment variables documented and commented
- `Makefile` or `just` commands for common tasks: `dev-up`, `dev-down`, `test`, `lint`, `format`, `migrate`, `seed`
- `README.md` with setup instructions, architecture overview, and contribution guide

---

## 13. Implementation Order (v1.0)

Suggested build sequence:

1. **Repository + git setup**: Initialize repo, .gitignore, pre-commit/pre-push hooks, commit message enforcement, PR and issue templates, README skeleton, Makefile/justfile with placeholder targets
2. **Project scaffolding**: Docker Compose, Caddy, FastAPI hello world with Ruff configured, Vite React hello world with ESLint + Prettier configured, PostgreSQL container, .env.example
3. **Database + migrations**: Alembic setup, initial schema (users, groups, group_members, invites, dashboards), check constraints, partial unique indexes, cardinality constraints
4. **Auth**: Registration (auto-create private dashboard), login, JWT cookies, refresh flow, CSRF protection, rate limiting
5. **Group management**: Create group (auto-create group dashboard), invite codes (generate, revoke, expiry, max uses, admin view), join, leave (set left_at), role management, dashboard editor grant/revoke
6. **Permissions service**: Action-type permission checks (contribute, edit, manage, administer) and dashboard permission checks (view, edit layout, manage widgets); resource_type + resource_id validation for widget bindings
7. **Sidebar layout**: Collapsible sidebar with logo, nav links, bell icon placeholder, user menu
8. **Lists module (backend)**: CRUD for lists and list items, visibility scoping, permission enforcement, soft delete
9. **Lists module (frontend)**: List full page with list-type-tailored UI, create/edit forms, check/uncheck items, scope filter (Mine + per-group)
10. **Activity events**: Backend activity_events table, logging on mutations, actor_display_name snapshot on write
11. **SSE infrastructure**: Multiplexed connection manager, event types, group-tagged broadcasting, reconnect with Last-Event-ID replay, resync threshold
12. **Real-time list sync**: Wire up list mutations to SSE broadcasts, frontend EventSource listener, Zustand store updates, duplicate event handling
13. **Notifications**: Bell icon with unread badge, slide-out panel, inbox-worthy vs activity-only split, actor suppression, coalescing, notification history page with Notifications and Activity tabs
14. **Dashboard system**: react-grid-layout integration, widget container, dashboard_widgets table, layout persistence, version conflict detection
15. **Private dashboard**: Per-user layout, cross-scope widget mixing, scope color indicators
16. **Group dashboards page**: Group dropdown, shared layout, owner/admin/dashboard-editor editing, view-only for other members, broken widget indicators
17. **List widget**: Interactive list widget with inline check/uncheck and add item, size-aware rendering, link to full page, soft-fail on deleted lists
18. **Additional widgets**: Clock widget, welcome/status widget
19. **Polish**: Error handling, loading states, empty states, scope indicators, departed user display, responsive tweaks, security headers
