
  import { z } from "zod";

// <Schemas>
export type ActivityEventResponse = z.infer<typeof ActivityEventResponse>;
export const ActivityEventResponse = z.object({ actor_display_name: z.string(), actor_id: z.uuid(), created_at: z.iso.datetime(), entity_id: z.uuid(), entity_type: z.string(), event_id: z.number().int(), event_type: z.string(), payload: z.record(z.string(), z.unknown()) });

export type EventType = z.infer<typeof EventType>;
export const EventType = z.enum(["list.created", "list.updated", "list.deleted", "list.reordered", "list.item.created", "list.item.updated", "list.item.checked", "list.item.deleted", "list.item.reordered", "dashboard.created", "dashboard.updated", "dashboard.deleted", "dashboard.share_added", "dashboard.share_updated", "dashboard.share_removed", "calendar.event.created", "calendar.event.updated", "calendar.event.deleted", "calendar.event.occurrence.updated", "calendar.event.occurrence.cancelled"]);

export type ChangedField = z.infer<typeof ChangedField>;
export const ChangedField = z.enum(["layout", "widgets", "name", "restored", "shares"]);

export type ActivitySsePayload = z.infer<typeof ActivitySsePayload>;
export const ActivitySsePayload = z.object({ changed_fields: z.array(ChangedField).nullable(), client_mutation_id: z.string().nullable(), config: z.record(z.string(), z.unknown()).nullable(), dashboard_id: z.string().nullable(), item_ids: z.array(z.string()).nullable(), list_id: z.string().nullable(), list_ids: z.array(z.string()).nullable(), values: z.record(z.string(), z.unknown()).nullable(), widget_id: z.string().nullable() }).partial().catchall(z.unknown());

export type ActivitySseEvent = z.infer<typeof ActivitySseEvent>;
export const ActivitySseEvent = z.object({ actor_display_name: z.string(), actor_id: z.string(), created_at: z.string(), entity_id: z.string(), entity_type: z.string(), entity_version: z.number().int(), event_id: z.number().int(), event_type: EventType, payload: ActivitySsePayload });

export type AgendaWidgetConfig = z.infer<typeof AgendaWidgetConfig>;
export const AgendaWidgetConfig = z.object({  }).partial().catchall(z.unknown());

export type AgendaWidgetCreate = z.infer<typeof AgendaWidgetCreate>;
export const AgendaWidgetCreate = z.object({ config: AgendaWidgetConfig.optional(), widget_type: z.literal("agenda") });

export type AgendaWidgetResponse = z.infer<typeof AgendaWidgetResponse>;
export const AgendaWidgetResponse = z.object({ config: AgendaWidgetConfig, created_at: z.iso.datetime(), dashboard_id: z.uuid(), id: z.uuid(), resource_id: z.uuid().nullable(), resource_type: z.string().nullable(), updated_at: z.iso.datetime(), widget_type: z.literal("agenda"), widget_version: z.number().int() });

export type RecurrenceRule = z.infer<typeof RecurrenceRule>;
export const RecurrenceRule = z.object({ by_weekday: z.array(z.number().int()).nullable().optional(), count: z.number().int().min(1).max(1000).nullable().optional(), frequency: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: z.number().int().min(1).max(366).default(1), until: z.iso.datetime().nullable().optional() });

export type CalendarEventCreate = z.infer<typeof CalendarEventCreate>;
export const CalendarEventCreate = z.object({ all_day: z.boolean().default(false), dashboard_id: z.uuid(), description: z.string().max(5000).nullable().optional(), ends_at: z.iso.datetime(), location: z.string().max(200).nullable().optional(), recurrence: RecurrenceRule.nullable().optional(), starts_at: z.iso.datetime(), timezone: z.string().min(1).max(100), title: z.string().min(1).max(200) });

export type CalendarEventResponse = z.infer<typeof CalendarEventResponse>;
export const CalendarEventResponse = z.object({ all_day: z.boolean(), created_at: z.iso.datetime(), created_by: z.uuid(), dashboard_id: z.uuid(), description: z.string().nullable(), ends_at: z.iso.datetime(), id: z.uuid(), location: z.string().nullable(), recurrence: RecurrenceRule.nullable(), starts_at: z.iso.datetime(), timezone: z.string(), title: z.string(), updated_at: z.iso.datetime(), updated_by: z.uuid() });

export type CalendarEventUpdate = z.infer<typeof CalendarEventUpdate>;
export const CalendarEventUpdate = z.object({ all_day: z.boolean().nullable(), description: z.string().max(5000).nullable(), ends_at: z.iso.datetime().nullable(), location: z.string().max(200).nullable(), recurrence: RecurrenceRule.nullable(), starts_at: z.iso.datetime().nullable(), timezone: z.string().min(1).max(100).nullable(), title: z.string().min(1).max(200).nullable() }).partial();

export type CalendarOccurrenceResponse = z.infer<typeof CalendarOccurrenceResponse>;
export const CalendarOccurrenceResponse = z.object({ all_day: z.boolean(), created_by: z.uuid(), description: z.string().nullable(), event_id: z.uuid(), is_exception: z.boolean(), location: z.string().nullable(), occurrence_end: z.iso.datetime(), occurrence_start: z.iso.datetime(), original_start: z.iso.datetime(), recurring: z.boolean(), timezone: z.string(), title: z.string() });

export type CalendarOccurrenceMutationResponse = z.infer<typeof CalendarOccurrenceMutationResponse>;
export const CalendarOccurrenceMutationResponse = z.object({ cancelled: z.boolean(), occurrence: CalendarOccurrenceResponse.nullable().optional() });

export type CalendarOccurrenceUpdate = z.infer<typeof CalendarOccurrenceUpdate>;
export const CalendarOccurrenceUpdate = z.object({ all_day: z.boolean().nullable().optional(), cancelled: z.boolean().default(false), description: z.string().max(5000).nullable().optional(), ends_at: z.iso.datetime().nullable().optional(), location: z.string().max(200).nullable().optional(), occurrence_start: z.iso.datetime(), starts_at: z.iso.datetime().nullable().optional(), timezone: z.string().min(1).max(100).nullable().optional(), title: z.string().min(1).max(200).nullable().optional() });

export type CalendarWidgetConfig = z.infer<typeof CalendarWidgetConfig>;
export const CalendarWidgetConfig = z.object({ view: z.string().nullable() }).partial().catchall(z.unknown());

export type CalendarWidgetCreate = z.infer<typeof CalendarWidgetCreate>;
export const CalendarWidgetCreate = z.object({ config: CalendarWidgetConfig.optional(), widget_type: z.literal("calendar") });

export type CalendarWidgetResponse = z.infer<typeof CalendarWidgetResponse>;
export const CalendarWidgetResponse = z.object({ config: CalendarWidgetConfig, created_at: z.iso.datetime(), dashboard_id: z.uuid(), id: z.uuid(), resource_id: z.uuid().nullable(), resource_type: z.string().nullable(), updated_at: z.iso.datetime(), widget_type: z.literal("calendar"), widget_version: z.number().int() });

export type ClockWidgetConfig = z.infer<typeof ClockWidgetConfig>;
export const ClockWidgetConfig = z.object({ timezone: z.string().nullable() }).partial().catchall(z.unknown());

export type ClockWidgetCreate = z.infer<typeof ClockWidgetCreate>;
export const ClockWidgetCreate = z.object({ config: ClockWidgetConfig.optional(), widget_type: z.literal("clock") });

export type ClockWidgetResponse = z.infer<typeof ClockWidgetResponse>;
export const ClockWidgetResponse = z.object({ config: ClockWidgetConfig, created_at: z.iso.datetime(), dashboard_id: z.uuid(), id: z.uuid(), resource_id: z.uuid().nullable(), resource_type: z.string().nullable(), updated_at: z.iso.datetime(), widget_type: z.literal("clock"), widget_version: z.number().int() });

export type ConnectedSseEvent = z.infer<typeof ConnectedSseEvent>;
export const ConnectedSseEvent = z.object({ last_event_id: z.number().int().nullable() }).partial().catchall(z.unknown());

export type PrincipalType = z.infer<typeof PrincipalType>;
export const PrincipalType = z.literal("user");

export type ShareRole = z.infer<typeof ShareRole>;
export const ShareRole = z.enum(["viewer", "editor"]);

export type ShareCreate = z.infer<typeof ShareCreate>;
export const ShareCreate = z.object({ principal_id: z.uuid(), principal_type: PrincipalType, role: ShareRole });

export type DashboardCreate = z.infer<typeof DashboardCreate>;
export const DashboardCreate = z.object({ name: z.string().min(1).max(100), shares: z.array(ShareCreate).optional() });

export type LayoutItem = z.infer<typeof LayoutItem>;
export const LayoutItem = z.object({ h: z.number().int(), i: z.string(), w: z.number().int(), x: z.number().int(), y: z.number().int() });

export type ListWidgetConfig = z.infer<typeof ListWidgetConfig>;
export const ListWidgetConfig = z.object({ list_name: z.string().nullable(), list_type: z.string().nullable() }).partial().catchall(z.unknown());

export type ListWidgetResponse = z.infer<typeof ListWidgetResponse>;
export const ListWidgetResponse = z.object({ config: ListWidgetConfig, created_at: z.iso.datetime(), dashboard_id: z.uuid(), id: z.uuid(), resource_id: z.uuid().nullable(), resource_type: z.string().nullable(), updated_at: z.iso.datetime(), widget_type: z.literal("list"), widget_version: z.number().int() });

export type DashboardResponse = z.infer<typeof DashboardResponse>;
export const DashboardResponse = z.object({ can_edit: z.boolean(), can_manage_shares: z.boolean(), id: z.uuid(), is_favorite: z.boolean(), is_shared: z.boolean(), layout: z.array(LayoutItem), name: z.string(), user_id: z.uuid(), version: z.number().int(), widgets: z.array(z.discriminatedUnion("widget_type", [AgendaWidgetResponse.extend({ widget_type: z.literal("agenda") }), CalendarWidgetResponse.extend({ widget_type: z.literal("calendar") }), ClockWidgetResponse.extend({ widget_type: z.literal("clock") }), ListWidgetResponse.extend({ widget_type: z.literal("list") })])) });

export type DashboardSummary = z.infer<typeof DashboardSummary>;
export const DashboardSummary = z.object({ access_description: z.string().nullable().optional(), can_edit: z.boolean(), can_manage_shares: z.boolean(), created_at: z.iso.datetime(), id: z.uuid(), is_favorite: z.boolean(), is_shared: z.boolean().default(false), name: z.string(), updated_at: z.iso.datetime(), user_id: z.uuid(), version: z.number().int() });

export type DashboardUpdate = z.infer<typeof DashboardUpdate>;
export const DashboardUpdate = z.object({ name: z.string().min(1).max(100).nullable() }).partial();

export type ValidationError = z.infer<typeof ValidationError>;
export const ValidationError = z.object({ ctx: z.record(z.string(), z.unknown()).optional(), input: z.unknown().optional(), loc: z.array(z.union([z.string(), z.number().int()])), msg: z.string(), type: z.string() });

export type HTTPValidationError = z.infer<typeof HTTPValidationError>;
export const HTTPValidationError = z.object({ detail: z.array(ValidationError) }).partial();

export type HealthResponse = z.infer<typeof HealthResponse>;
export const HealthResponse = z.object({ status: z.string() });

export type InheritedDashboardAccessResponse = z.infer<typeof InheritedDashboardAccessResponse>;
export const InheritedDashboardAccessResponse = z.object({ dashboard_id: z.uuid(), dashboard_name: z.string() });

export type InviteAcceptResponse = z.infer<typeof InviteAcceptResponse>;
export const InviteAcceptResponse = z.object({ dashboard_id: z.uuid(), dashboard_name: z.string(), role: ShareRole.nullable() });

export type InviteCreate = z.infer<typeof InviteCreate>;
export const InviteCreate = z.object({ role: ShareRole });

export type InviteCreatedResponse = z.infer<typeof InviteCreatedResponse>;
export const InviteCreatedResponse = z.object({ code: z.string(), created_at: z.iso.datetime(), expires_at: z.iso.datetime(), id: z.uuid(), role: ShareRole });

export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponse>;
export const InvitePreviewResponse = z.object({ dashboard_name: z.string(), invited_by: z.string(), role: ShareRole });

export type InviteResponse = z.infer<typeof InviteResponse>;
export const InviteResponse = z.object({ created_at: z.iso.datetime(), expires_at: z.iso.datetime(), id: z.uuid(), role: ShareRole });

export type ItemPriority = z.infer<typeof ItemPriority>;
export const ItemPriority = z.enum(["low", "medium", "high"]);

export type ItemReorder = z.infer<typeof ItemReorder>;
export const ItemReorder = z.object({ item_ids: z.array(z.uuid()).min(1).max(1000) });

export type LayoutUpdate = z.infer<typeof LayoutUpdate>;
export const LayoutUpdate = z.object({ layout: z.array(LayoutItem), version: z.number().int() });

export type ListType = z.infer<typeof ListType>;
export const ListType = z.enum(["checklist", "grocery", "todo"]);

export type ListCreate = z.infer<typeof ListCreate>;
export const ListCreate = z.object({ dashboard_id: z.uuid(), list_type: ListType, name: z.string().min(1).max(200) });

export type ListItemResponse = z.infer<typeof ListItemResponse>;
export const ListItemResponse = z.object({ assigned_to: z.uuid().nullable(), category: z.string().nullable(), checked: z.boolean(), created_at: z.iso.datetime(), created_by: z.uuid(), due_date: z.iso.date().nullable(), id: z.uuid(), list_id: z.uuid(), priority: ItemPriority.nullable(), sort_order: z.number().int(), text: z.string(), updated_at: z.iso.datetime() });

export type ListDetailResponse = z.infer<typeof ListDetailResponse>;
export const ListDetailResponse = z.object({ created_at: z.iso.datetime(), created_by: z.uuid(), dashboard_id: z.uuid(), id: z.uuid(), item_count: z.number().int(), items: z.array(ListItemResponse), list_type: ListType, name: z.string(), sort_order: z.number().int(), updated_at: z.iso.datetime() });

export type ListItemCreate = z.infer<typeof ListItemCreate>;
export const ListItemCreate = z.object({ assigned_to: z.uuid().nullable().optional(), category: z.string().max(100).nullable().optional(), due_date: z.iso.date().nullable().optional(), priority: ItemPriority.nullable().optional(), text: z.string().min(1).max(2000) });

export type ListItemUpdate = z.infer<typeof ListItemUpdate>;
export const ListItemUpdate = z.object({ assigned_to: z.uuid().nullable(), category: z.string().max(100).nullable(), checked: z.boolean().nullable(), due_date: z.iso.date().nullable(), priority: ItemPriority.nullable(), text: z.string().min(1).max(2000).nullable() }).partial();

export type ListReorder = z.infer<typeof ListReorder>;
export const ListReorder = z.object({ dashboard_id: z.uuid(), list_ids: z.array(z.uuid()).min(1).max(1000) });

export type ListResponse = z.infer<typeof ListResponse>;
export const ListResponse = z.object({ created_at: z.iso.datetime(), created_by: z.uuid(), dashboard_id: z.uuid(), id: z.uuid(), item_count: z.number().int(), list_type: ListType, name: z.string(), sort_order: z.number().int(), updated_at: z.iso.datetime() });

export type ListUpdate = z.infer<typeof ListUpdate>;
export const ListUpdate = z.object({ name: z.string().min(1).max(200).nullable() }).partial();

export type ListWidgetCreateConfig = z.infer<typeof ListWidgetCreateConfig>;
export const ListWidgetCreateConfig = z.object({ list_name: z.string().nullable(), list_type: z.string().nullable(), name: z.string().nullable() }).partial().catchall(z.unknown());

export type ListWidgetCreate = z.infer<typeof ListWidgetCreate>;
export const ListWidgetCreate = z.object({ config: ListWidgetCreateConfig.optional(), resource_id: z.uuid().nullable().optional(), resource_type: z.literal("list").nullable().optional(), widget_type: z.literal("list") });

export type LoginRequest = z.infer<typeof LoginRequest>;
export const LoginRequest = z.object({ email: z.email(), password: z.string() });

export type NotificationResponse = z.infer<typeof NotificationResponse>;
export const NotificationResponse = z.object({ body: z.string(), created_at: z.iso.datetime(), id: z.uuid(), read_at: z.iso.datetime().nullable(), reference_id: z.uuid().nullable(), reference_type: z.string().nullable(), title: z.string(), type: z.string() });

export type NotificationPageResponse = z.infer<typeof NotificationPageResponse>;
export const NotificationPageResponse = z.object({ items: z.array(NotificationResponse), next_cursor: z.string().nullable() });

export type NotificationSseEvent = z.infer<typeof NotificationSseEvent>;
export const NotificationSseEvent = z.object({ body: z.string(), created_at: z.string(), id: z.string(), read_at: z.string().nullable(), reference_id: z.string().nullable(), reference_type: z.string().nullable(), title: z.string(), type: z.string() });

export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>;
export const PasswordChangeRequest = z.object({ current_password: z.string(), new_password: z.string().min(8).max(128) });

export type PasswordResetConfirmRequest = z.infer<typeof PasswordResetConfirmRequest>;
export const PasswordResetConfirmRequest = z.object({ new_password: z.string().min(8).max(128), token: z.string().min(1) });

export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>;
export const PasswordResetRequest = z.object({ email: z.email() });

export type PasswordResetTokenCheck = z.infer<typeof PasswordResetTokenCheck>;
export const PasswordResetTokenCheck = z.object({ token: z.string().min(1) });

export type PasswordResetTokenStatus = z.infer<typeof PasswordResetTokenStatus>;
export const PasswordResetTokenStatus = z.object({ valid: z.boolean() });

export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>;
export const PreferencesUpdate = z.object({ favorite_dashboard_ids: z.array(z.string()).nullable(), home_dashboard_id: z.string().nullable() }).partial();

export type ProfileUpdate = z.infer<typeof ProfileUpdate>;
export const ProfileUpdate = z.object({ display_name: z.string().nullable() }).partial();

export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
export const ReadinessResponse = z.object({ database: z.boolean(), status: z.string() });

export type RegisterRequest = z.infer<typeof RegisterRequest>;
export const RegisterRequest = z.object({ display_name: z.string(), email: z.email(), password: z.string().min(8).max(128) });

export type RegistrationResponse = z.infer<typeof RegistrationResponse>;
export const RegistrationResponse = z.object({ email: z.string() });

export type ResendVerificationRequest = z.infer<typeof ResendVerificationRequest>;
export const ResendVerificationRequest = z.object({ email: z.email() });

export type ShareResponse = z.infer<typeof ShareResponse>;
export const ShareResponse = z.object({ created_at: z.iso.datetime(), granted_by: z.uuid(), id: z.uuid(), principal_id: z.uuid(), principal_name: z.string(), principal_type: PrincipalType, resource_id: z.uuid(), resource_type: z.string(), role: ShareRole });

export type ResourceAccessResponse = z.infer<typeof ResourceAccessResponse>;
export const ResourceAccessResponse = z.object({ direct_shares: z.array(ShareResponse), inherited_dashboards: z.array(InheritedDashboardAccessResponse).default([]) });

export type ResyncSseEvent = z.infer<typeof ResyncSseEvent>;
export const ResyncSseEvent = z.object({ reason: z.string(), scopes: z.array(z.string()).nullable().optional() });

export type ShareUpdate = z.infer<typeof ShareUpdate>;
export const ShareUpdate = z.object({ role: ShareRole });

export type TrashedDashboardSummary = z.infer<typeof TrashedDashboardSummary>;
export const TrashedDashboardSummary = z.object({ deleted_at: z.iso.datetime(), id: z.uuid(), name: z.string(), purge_at: z.iso.datetime() });

export type TrashedListSummary = z.infer<typeof TrashedListSummary>;
export const TrashedListSummary = z.object({ dashboard_id: z.uuid(), deleted_at: z.iso.datetime(), id: z.uuid(), list_type: ListType, name: z.string(), purge_at: z.iso.datetime() });

export type UnreadCountResponse = z.infer<typeof UnreadCountResponse>;
export const UnreadCountResponse = z.object({ count: z.number().int() });

export type UserPreferences = z.infer<typeof UserPreferences>;
export const UserPreferences = z.object({ favorite_dashboard_ids: z.array(z.string()), home_dashboard_id: z.string().nullable() }).partial();

export type UserResponse = z.infer<typeof UserResponse>;
export const UserResponse = z.object({ display_name: z.string(), email: z.string(), email_verified_at: z.iso.datetime().nullable().optional(), id: z.uuid(), preferences: UserPreferences.optional() });

export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>;
export const VerifyEmailRequest = z.object({ token: z.string().min(1) });

export type WidgetConfigUpdate = z.infer<typeof WidgetConfigUpdate>;
export const WidgetConfigUpdate = z.object({ config: z.record(z.string(), z.unknown()) });

// </Schemas>

  
  
  