
  import { z } from 'zod'

export type ActivityEventResponse = z.infer<typeof ActivityEventResponse>
export const ActivityEventResponse = z.object({
  actor_display_name: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
  entity_id: z.string(),
  entity_type: z.string(),
  event_id: z.number(),
  event_type: z.string(),
  payload: z.record(z.unknown())
})

export type EventType = z.infer<typeof EventType>
export const EventType = z.union([
  z.literal('list.created'),
  z.literal('list.updated'),
  z.literal('list.archived'),
  z.literal('list.deleted'),
  z.literal('list.reordered'),
  z.literal('list.item.created'),
  z.literal('list.item.updated'),
  z.literal('list.item.checked'),
  z.literal('list.item.deleted'),
  z.literal('list.item.reordered'),
  z.literal('dashboard.created'),
  z.literal('dashboard.updated'),
  z.literal('dashboard.deleted'),
  z.literal('dashboard.share_added'),
  z.literal('dashboard.share_updated'),
  z.literal('dashboard.share_removed'),
  z.literal('calendar.event.created'),
  z.literal('calendar.event.updated'),
  z.literal('calendar.event.deleted'),
  z.literal('calendar.event.occurrence.updated'),
  z.literal('calendar.event.occurrence.cancelled')
])

export type ActivitySsePayload = z.infer<typeof ActivitySsePayload>
export const ActivitySsePayload = z.intersection(
  z.object({
    changed_fields: z.union([z.array(z.string()), z.null()]).optional(),
    client_mutation_id: z.union([z.string(), z.null()]).optional(),
    dashboard_id: z.union([z.string(), z.null()]).optional(),
    item_ids: z.union([z.array(z.string()), z.null()]).optional(),
    list_id: z.union([z.string(), z.null()]).optional(),
    list_ids: z.union([z.array(z.string()), z.null()]).optional(),
    values: z.union([z.record(z.unknown()), z.null()]).optional()
  }),
  z.object({})
)

export type ActivitySseEvent = z.infer<typeof ActivitySseEvent>
export const ActivitySseEvent = z.object({
  actor_display_name: z.string(),
  actor_id: z.string(),
  created_at: z.string(),
  entity_id: z.string(),
  entity_type: z.string(),
  entity_version: z.number(),
  event_id: z.number(),
  event_type: EventType,
  payload: ActivitySsePayload
})

export type AgendaWidgetConfig = z.infer<typeof AgendaWidgetConfig>
export const AgendaWidgetConfig = z.intersection(z.object({}), z.object({}))

export type AgendaWidgetCreate = z.infer<typeof AgendaWidgetCreate>
export const AgendaWidgetCreate = z.object({
  config: z.union([AgendaWidgetConfig, z.undefined()]).optional(),
  widget_type: z.literal('agenda')
})

export type AgendaWidgetResponse = z.infer<typeof AgendaWidgetResponse>
export const AgendaWidgetResponse = z.object({
  config: AgendaWidgetConfig,
  created_at: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  resource_id: z.union([z.string(), z.null()]),
  resource_type: z.union([z.string(), z.null()]),
  updated_at: z.string(),
  widget_type: z.literal('agenda'),
  widget_version: z.number()
})

export type RecurrenceRule = z.infer<typeof RecurrenceRule>
export const RecurrenceRule = z.object({
  by_weekday: z
    .union([z.union([z.array(z.number()), z.null()]), z.undefined()])
    .optional(),
  count: z.union([z.union([z.number(), z.null()]), z.undefined()]).optional(),
  frequency: z.string(),
  interval: z.union([z.number(), z.undefined()]).optional(),
  until: z.union([z.union([z.string(), z.null()]), z.undefined()]).optional()
})

export type CalendarEventCreate = z.infer<typeof CalendarEventCreate>
export const CalendarEventCreate = z.object({
  all_day: z.union([z.boolean(), z.undefined()]).optional(),
  dashboard_id: z.string(),
  description: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  ends_at: z.string(),
  location: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  recurrence: z
    .union([z.union([RecurrenceRule, z.null()]), z.undefined()])
    .optional(),
  starts_at: z.string(),
  timezone: z.string(),
  title: z.string()
})

export type CalendarEventResponse = z.infer<typeof CalendarEventResponse>
export const CalendarEventResponse = z.object({
  all_day: z.boolean(),
  created_at: z.string(),
  created_by: z.string(),
  dashboard_id: z.string(),
  description: z.union([z.string(), z.null()]),
  ends_at: z.string(),
  id: z.string(),
  location: z.union([z.string(), z.null()]),
  recurrence: z.union([RecurrenceRule, z.null()]),
  starts_at: z.string(),
  timezone: z.string(),
  title: z.string(),
  updated_at: z.string(),
  updated_by: z.string()
})

export type CalendarEventUpdate = z.infer<typeof CalendarEventUpdate>
export const CalendarEventUpdate = z.object({
  all_day: z.union([z.boolean(), z.null()]).optional(),
  description: z.union([z.string(), z.null()]).optional(),
  ends_at: z.union([z.string(), z.null()]).optional(),
  location: z.union([z.string(), z.null()]).optional(),
  recurrence: z.union([RecurrenceRule, z.null()]).optional(),
  starts_at: z.union([z.string(), z.null()]).optional(),
  timezone: z.union([z.string(), z.null()]).optional(),
  title: z.union([z.string(), z.null()]).optional()
})

export type CalendarOccurrenceResponse = z.infer<
  typeof CalendarOccurrenceResponse
>
export const CalendarOccurrenceResponse = z.object({
  all_day: z.boolean(),
  created_by: z.string(),
  description: z.union([z.string(), z.null()]),
  event_id: z.string(),
  is_exception: z.boolean(),
  location: z.union([z.string(), z.null()]),
  occurrence_end: z.string(),
  occurrence_start: z.string(),
  original_start: z.string(),
  recurring: z.boolean(),
  timezone: z.string(),
  title: z.string()
})

export type CalendarOccurrenceMutationResponse = z.infer<
  typeof CalendarOccurrenceMutationResponse
>
export const CalendarOccurrenceMutationResponse = z.object({
  cancelled: z.boolean(),
  occurrence: z
    .union([z.union([CalendarOccurrenceResponse, z.null()]), z.undefined()])
    .optional()
})

export type CalendarOccurrenceUpdate = z.infer<typeof CalendarOccurrenceUpdate>
export const CalendarOccurrenceUpdate = z.object({
  all_day: z
    .union([z.union([z.boolean(), z.null()]), z.undefined()])
    .optional(),
  cancelled: z.union([z.boolean(), z.undefined()]).optional(),
  description: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  ends_at: z.union([z.union([z.string(), z.null()]), z.undefined()]).optional(),
  location: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  occurrence_start: z.string(),
  starts_at: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  timezone: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  title: z.union([z.union([z.string(), z.null()]), z.undefined()]).optional()
})

export type CalendarWidgetConfig = z.infer<typeof CalendarWidgetConfig>
export const CalendarWidgetConfig = z.intersection(
  z.object({
    view: z.union([z.string(), z.null()]).optional()
  }),
  z.object({})
)

export type CalendarWidgetCreate = z.infer<typeof CalendarWidgetCreate>
export const CalendarWidgetCreate = z.object({
  config: z.union([CalendarWidgetConfig, z.undefined()]).optional(),
  widget_type: z.literal('calendar')
})

export type CalendarWidgetResponse = z.infer<typeof CalendarWidgetResponse>
export const CalendarWidgetResponse = z.object({
  config: CalendarWidgetConfig,
  created_at: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  resource_id: z.union([z.string(), z.null()]),
  resource_type: z.union([z.string(), z.null()]),
  updated_at: z.string(),
  widget_type: z.literal('calendar'),
  widget_version: z.number()
})

export type ClockWidgetConfig = z.infer<typeof ClockWidgetConfig>
export const ClockWidgetConfig = z.intersection(
  z.object({
    timezone: z.union([z.string(), z.null()]).optional()
  }),
  z.object({})
)

export type ClockWidgetCreate = z.infer<typeof ClockWidgetCreate>
export const ClockWidgetCreate = z.object({
  config: z.union([ClockWidgetConfig, z.undefined()]).optional(),
  widget_type: z.literal('clock')
})

export type ClockWidgetResponse = z.infer<typeof ClockWidgetResponse>
export const ClockWidgetResponse = z.object({
  config: ClockWidgetConfig,
  created_at: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  resource_id: z.union([z.string(), z.null()]),
  resource_type: z.union([z.string(), z.null()]),
  updated_at: z.string(),
  widget_type: z.literal('clock'),
  widget_version: z.number()
})

export type ConnectedSseEvent = z.infer<typeof ConnectedSseEvent>
export const ConnectedSseEvent = z.intersection(z.object({}), z.object({}))

export type PrincipalType = z.infer<typeof PrincipalType>
export const PrincipalType = z.literal('user')

export type ShareRole = z.infer<typeof ShareRole>
export const ShareRole = z.union([z.literal('viewer'), z.literal('editor')])

export type ShareCreate = z.infer<typeof ShareCreate>
export const ShareCreate = z.object({
  principal_id: z.string(),
  principal_type: PrincipalType,
  role: ShareRole
})

export type DashboardCreate = z.infer<typeof DashboardCreate>
export const DashboardCreate = z.object({
  name: z.string(),
  shares: z.union([z.array(ShareCreate), z.undefined()]).optional()
})

export type LayoutItem = z.infer<typeof LayoutItem>
export const LayoutItem = z.object({
  h: z.number(),
  i: z.string(),
  w: z.number(),
  x: z.number(),
  y: z.number()
})

export type ListWidgetConfig = z.infer<typeof ListWidgetConfig>
export const ListWidgetConfig = z.intersection(
  z.object({
    list_name: z.union([z.string(), z.null()]).optional(),
    list_type: z.union([z.string(), z.null()]).optional()
  }),
  z.object({})
)

export type ListWidgetResponse = z.infer<typeof ListWidgetResponse>
export const ListWidgetResponse = z.object({
  config: ListWidgetConfig,
  created_at: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  resource_id: z.union([z.string(), z.null()]),
  resource_type: z.union([z.string(), z.null()]),
  updated_at: z.string(),
  widget_type: z.literal('list'),
  widget_version: z.number()
})

export type DashboardResponse = z.infer<typeof DashboardResponse>
export const DashboardResponse = z.object({
  archived: z.boolean(),
  can_edit: z.boolean(),
  can_manage_shares: z.boolean(),
  id: z.string(),
  is_favorite: z.boolean(),
  is_shared: z.boolean(),
  layout: z.array(LayoutItem),
  name: z.string(),
  user_id: z.string(),
  version: z.number(),
  widgets: z.array(
    z.union([
      ClockWidgetResponse,
      CalendarWidgetResponse,
      ListWidgetResponse,
      AgendaWidgetResponse
    ])
  )
})

export type DashboardSummary = z.infer<typeof DashboardSummary>
export const DashboardSummary = z.object({
  access_description: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  archived: z.boolean(),
  can_edit: z.boolean(),
  can_manage_shares: z.boolean(),
  created_at: z.string(),
  id: z.string(),
  is_favorite: z.boolean(),
  is_shared: z.union([z.boolean(), z.undefined()]).optional(),
  name: z.string(),
  updated_at: z.string(),
  user_id: z.string(),
  version: z.number()
})

export type DashboardUpdate = z.infer<typeof DashboardUpdate>
export const DashboardUpdate = z.object({
  archived: z.union([z.boolean(), z.null()]).optional(),
  name: z.union([z.string(), z.null()]).optional()
})

export type ValidationError = z.infer<typeof ValidationError>
export const ValidationError = z.object({
  ctx: z.union([z.record(z.unknown()), z.undefined()]).optional(),
  input: z.union([z.unknown(), z.undefined()]).optional(),
  loc: z.array(z.union([z.string(), z.number()])),
  msg: z.string(),
  type: z.string()
})

export type HTTPValidationError = z.infer<typeof HTTPValidationError>
export const HTTPValidationError = z.object({
  detail: z.array(ValidationError).optional()
})

export type HealthResponse = z.infer<typeof HealthResponse>
export const HealthResponse = z.object({
  status: z.string()
})

export type InheritedDashboardAccessResponse = z.infer<
  typeof InheritedDashboardAccessResponse
>
export const InheritedDashboardAccessResponse = z.object({
  dashboard_id: z.string(),
  dashboard_name: z.string()
})

export type InviteAcceptResponse = z.infer<typeof InviteAcceptResponse>
export const InviteAcceptResponse = z.object({
  dashboard_id: z.string(),
  dashboard_name: z.string(),
  role: ShareRole
})

export type InviteCreate = z.infer<typeof InviteCreate>
export const InviteCreate = z.object({
  role: ShareRole
})

export type InviteCreatedResponse = z.infer<typeof InviteCreatedResponse>
export const InviteCreatedResponse = z.object({
  code: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  role: ShareRole
})

export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponse>
export const InvitePreviewResponse = z.object({
  dashboard_name: z.string(),
  invited_by: z.string(),
  role: ShareRole
})

export type InviteResponse = z.infer<typeof InviteResponse>
export const InviteResponse = z.object({
  created_at: z.string(),
  expires_at: z.string(),
  id: z.string(),
  role: ShareRole
})

export type ItemPriority = z.infer<typeof ItemPriority>
export const ItemPriority = z.union([
  z.literal('low'),
  z.literal('medium'),
  z.literal('high')
])

export type ItemReorder = z.infer<typeof ItemReorder>
export const ItemReorder = z.object({
  item_ids: z.array(z.string())
})

export type LayoutUpdate = z.infer<typeof LayoutUpdate>
export const LayoutUpdate = z.object({
  layout: z.array(LayoutItem),
  version: z.number()
})

export type ListType = z.infer<typeof ListType>
export const ListType = z.union([
  z.literal('checklist'),
  z.literal('grocery'),
  z.literal('todo')
])

export type ListCreate = z.infer<typeof ListCreate>
export const ListCreate = z.object({
  dashboard_id: z.string(),
  list_type: ListType,
  name: z.string()
})

export type ListItemResponse = z.infer<typeof ListItemResponse>
export const ListItemResponse = z.object({
  assigned_to: z.union([z.string(), z.null()]),
  category: z.union([z.string(), z.null()]),
  checked: z.boolean(),
  created_at: z.string(),
  created_by: z.string(),
  due_date: z.union([z.string(), z.null()]),
  id: z.string(),
  list_id: z.string(),
  priority: z.union([ItemPriority, z.null()]),
  sort_order: z.number(),
  text: z.string(),
  updated_at: z.string()
})

export type ListDetailResponse = z.infer<typeof ListDetailResponse>
export const ListDetailResponse = z.object({
  archived: z.boolean(),
  created_at: z.string(),
  created_by: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  item_count: z.number(),
  items: z.array(ListItemResponse),
  list_type: ListType,
  name: z.string(),
  sort_order: z.number(),
  updated_at: z.string()
})

export type ListItemCreate = z.infer<typeof ListItemCreate>
export const ListItemCreate = z.object({
  assigned_to: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  category: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  due_date: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  priority: z
    .union([z.union([ItemPriority, z.null()]), z.undefined()])
    .optional(),
  text: z.string()
})

export type ListItemUpdate = z.infer<typeof ListItemUpdate>
export const ListItemUpdate = z.object({
  assigned_to: z.union([z.string(), z.null()]).optional(),
  category: z.union([z.string(), z.null()]).optional(),
  checked: z.union([z.boolean(), z.null()]).optional(),
  due_date: z.union([z.string(), z.null()]).optional(),
  priority: z.union([ItemPriority, z.null()]).optional(),
  text: z.union([z.string(), z.null()]).optional()
})

export type ListReorder = z.infer<typeof ListReorder>
export const ListReorder = z.object({
  dashboard_id: z.string(),
  list_ids: z.array(z.string())
})

export type ListResponse = z.infer<typeof ListResponse>
export const ListResponse = z.object({
  archived: z.boolean(),
  created_at: z.string(),
  created_by: z.string(),
  dashboard_id: z.string(),
  id: z.string(),
  item_count: z.number(),
  list_type: ListType,
  name: z.string(),
  sort_order: z.number(),
  updated_at: z.string()
})

export type ListUpdate = z.infer<typeof ListUpdate>
export const ListUpdate = z.object({
  archived: z.union([z.boolean(), z.null()]).optional(),
  name: z.union([z.string(), z.null()]).optional()
})

export type ListWidgetCreateConfig = z.infer<typeof ListWidgetCreateConfig>
export const ListWidgetCreateConfig = z.intersection(
  z.object({
    list_name: z.union([z.string(), z.null()]).optional(),
    list_type: z.union([z.string(), z.null()]).optional(),
    name: z.union([z.string(), z.null()]).optional()
  }),
  z.object({})
)

export type ListWidgetCreate = z.infer<typeof ListWidgetCreate>
export const ListWidgetCreate = z.object({
  config: z.union([ListWidgetCreateConfig, z.undefined()]).optional(),
  resource_id: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  resource_type: z
    .union([z.union([z.literal('list'), z.null()]), z.undefined()])
    .optional(),
  widget_type: z.literal('list')
})

export type LoginRequest = z.infer<typeof LoginRequest>
export const LoginRequest = z.object({
  email: z.string(),
  password: z.string()
})

export type NotificationResponse = z.infer<typeof NotificationResponse>
export const NotificationResponse = z.object({
  body: z.string(),
  created_at: z.string(),
  id: z.string(),
  read_at: z.union([z.string(), z.null()]),
  reference_id: z.union([z.string(), z.null()]),
  reference_type: z.union([z.string(), z.null()]),
  title: z.string(),
  type: z.string()
})

export type NotificationPageResponse = z.infer<typeof NotificationPageResponse>
export const NotificationPageResponse = z.object({
  items: z.array(NotificationResponse),
  next_cursor: z.union([z.string(), z.null()])
})

export type NotificationSseEvent = z.infer<typeof NotificationSseEvent>
export const NotificationSseEvent = z.object({
  body: z.string(),
  created_at: z.string(),
  id: z.string(),
  read_at: z.union([z.string(), z.null()]),
  reference_id: z.union([z.string(), z.null()]),
  reference_type: z.union([z.string(), z.null()]),
  title: z.string(),
  type: z.string()
})

export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequest>
export const PasswordChangeRequest = z.object({
  current_password: z.string(),
  new_password: z.string()
})

export type PasswordResetConfirmRequest = z.infer<
  typeof PasswordResetConfirmRequest
>
export const PasswordResetConfirmRequest = z.object({
  new_password: z.string(),
  token: z.string()
})

export type PasswordResetRequest = z.infer<typeof PasswordResetRequest>
export const PasswordResetRequest = z.object({
  email: z.string()
})

export type PreferencesUpdate = z.infer<typeof PreferencesUpdate>
export const PreferencesUpdate = z.object({
  favorite_dashboard_ids: z.union([z.array(z.string()), z.null()]).optional(),
  home_dashboard_id: z.union([z.string(), z.null()]).optional()
})

export type ProfileUpdate = z.infer<typeof ProfileUpdate>
export const ProfileUpdate = z.object({
  display_name: z.union([z.string(), z.null()]).optional()
})

export type ReadinessResponse = z.infer<typeof ReadinessResponse>
export const ReadinessResponse = z.object({
  database: z.boolean(),
  status: z.string()
})

export type RegisterRequest = z.infer<typeof RegisterRequest>
export const RegisterRequest = z.object({
  display_name: z.string(),
  email: z.string(),
  password: z.string()
})

export type RegistrationResponse = z.infer<typeof RegistrationResponse>
export const RegistrationResponse = z.object({
  email: z.string()
})

export type ResendVerificationRequest = z.infer<
  typeof ResendVerificationRequest
>
export const ResendVerificationRequest = z.object({
  email: z.string()
})

export type ShareResponse = z.infer<typeof ShareResponse>
export const ShareResponse = z.object({
  created_at: z.string(),
  granted_by: z.string(),
  id: z.string(),
  principal_id: z.string(),
  principal_name: z.string(),
  principal_type: PrincipalType,
  resource_id: z.string(),
  resource_type: z.string(),
  role: ShareRole
})

export type ResourceAccessResponse = z.infer<typeof ResourceAccessResponse>
export const ResourceAccessResponse = z.object({
  direct_shares: z.array(ShareResponse),
  inherited_dashboards: z
    .union([z.array(InheritedDashboardAccessResponse), z.undefined()])
    .optional()
})

export type ResyncSseEvent = z.infer<typeof ResyncSseEvent>
export const ResyncSseEvent = z.object({
  reason: z.string()
})

export type ShareUpdate = z.infer<typeof ShareUpdate>
export const ShareUpdate = z.object({
  role: ShareRole
})

export type UnreadCountResponse = z.infer<typeof UnreadCountResponse>
export const UnreadCountResponse = z.object({
  count: z.number()
})

export type UserPreferences = z.infer<typeof UserPreferences>
export const UserPreferences = z.object({
  favorite_dashboard_ids: z.array(z.string()).optional(),
  home_dashboard_id: z.union([z.string(), z.null()]).optional()
})

export type UserResponse = z.infer<typeof UserResponse>
export const UserResponse = z.object({
  display_name: z.string(),
  email: z.string(),
  email_verified_at: z
    .union([z.union([z.string(), z.null()]), z.undefined()])
    .optional(),
  id: z.string(),
  preferences: z.union([UserPreferences, z.undefined()]).optional()
})

export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequest>
export const VerifyEmailRequest = z.object({
  token: z.string()
})

export type WidgetConfigUpdate = z.infer<typeof WidgetConfigUpdate>
export const WidgetConfigUpdate = z.object({
  config: z.record(z.unknown())
})

  
  
  