import { defineContract } from '@prisma/orm-postgres/contract-builder';

// LeadFlow BD data contract — source of truth for the database schema.
// Auth + multi-tenant workspace models. Every tenant-owned resource carries
// `businessId` and is always queried scoped by it (see src/lib/tenancy/).
export const contract = defineContract({}, ({ field, model, rel }) => {
  const User = model('User', {
    fields: {
      id: field.id.uuidv7String(),
      email: field.text().unique(),
      name: field.text().optional(),
      passwordHash: field.text(),
      status: field.text().default('ACTIVE'),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  const Session = model('Session', {
    fields: {
      id: field.id.uuidv7String(),
      userId: field.uuidString(),
      // SHA-256 hex of the opaque session token. The raw token only ever
      // lives in the user's httpOnly cookie — never in the database.
      tokenHash: field.text().unique(),
      expiresAt: field.temporal.timestamptzString(),
      revokedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
    },
  });

  const PasswordResetToken = model('PasswordResetToken', {
    fields: {
      id: field.id.uuidv7String(),
      userId: field.uuidString(),
      // SHA-256 hex of the opaque reset token. Single-use, short-lived.
      tokenHash: field.text().unique(),
      expiresAt: field.temporal.timestamptzString(),
      usedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
    },
  });

  // Tenant root. `ownerId` is the creating user; day-to-day access is
  // governed by BusinessMember rows (a user may belong to many businesses).
  // `status` is ACTIVE | SUSPENDED as plain text; suspended workspaces
  // refuse all member access and pause integrations (see
  // src/lib/tenancy/businesses.ts). New rows default to ACTIVE so the
  // column backfills safely.
  const Business = model('Business', {
    fields: {
      id: field.id.uuidv7String(),
      name: field.text(),
      ownerId: field.uuidString(),
      status: field.text().default('ACTIVE'),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Membership of a user in a business + their workspace role
  // (OWNER | ADMIN | SALES as plain text; see src/lib/tenancy/roles.ts).
  const BusinessMember = model('BusinessMember', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      userId: field.uuidString(),
      role: field.text().default('SALES'),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Workspace roles catalog (seeded: OWNER, ADMIN, SALES).
  const Role = model('Role', {
    fields: {
      id: field.id.uuidv7String(),
      name: field.text().unique(),
      description: field.text().optional(),
      createdAt: field.temporal.createdAtString(),
    },
  });

  // Permission catalog (seeded `code`s, e.g. "leads.read").
  const Permission = model('Permission', {
    fields: {
      id: field.id.uuidv7String(),
      code: field.text().unique(),
      description: field.text().optional(),
      createdAt: field.temporal.createdAtString(),
    },
  });

  // Join: which permissions each role grants.
  const RolePermission = model('RolePermission', {
    fields: {
      id: field.id.uuidv7String(),
      roleId: field.uuidString(),
      permissionId: field.uuidString(),
      createdAt: field.temporal.createdAtString(),
    },
  });

  // SaaS plan catalog (seeded: FREE, STARTER, GROWTH, BUSINESS, AGENCY).
  // `code` is the stable key used by subscriptions and the static catalog
  // in src/lib/billing/catalog.ts. Limits: leads created per calendar
  // month, members per workspace, workspaces per owning user
  // (`maxBusinesses === null` means unlimited — AGENCY only).
  const Plan = model('Plan', {
    fields: {
      id: field.id.uuidv7String(),
      code: field.text().unique(),
      name: field.text(),
      leadsPerMonth: field.int(),
      maxUsers: field.int(),
      maxBusinesses: field.int().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Workspace subscription: exactly one per business (unique `businessId`),
  // created lazily as FREE on first read. `status` is ACTIVE | PAST_DUE |
  // CANCELED as plain text; only ACTIVE permits quota-consuming writes.
  // Monthly billing cycle anchored at creation (or last plan change):
  // `currentPeriodStart`/`currentPeriodEnd` roll forward lazily on read,
  // and `currentPeriodEnd` is the renewal date surfaced in billing UI.
  const Subscription = model('Subscription', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString().unique(),
      planCode: field.text().default('FREE'),
      status: field.text().default('ACTIVE'),
      billingCycle: field.text().default('MONTHLY'),
      currentPeriodStart: field.temporal.timestamptzString(),
      currentPeriodEnd: field.temporal.timestamptzString(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // SSLCommerz payment attempt. One row per checkout: `tranId` is the
  // gateway-wide unique transaction id (unique constraint = idempotency
  // key for duplicate IPN/callback replays). `status` is INITIATED |
  // PENDING | SUCCESS | FAILED | CANCELLED | EXPIRED | RISK_HOLD as plain
  // text. Money is stored as integer minor units (`amountMinor`, poisha)
  // with `currency` so server-side amount checks never touch floats.
  // `activatedAt` marks the single subscription activation derived from
  // this payment — duplicate callbacks after it are acknowledged no-ops.
  const Payment = model('Payment', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      userId: field.uuidString(),
      planCode: field.text(),
      amountMinor: field.int(),
      currency: field.text().default('BDT'),
      tranId: field.text().unique(),
      valId: field.text().optional(),
      status: field.text().default('INITIATED'),
      gatewaySessionKey: field.text().optional(),
      riskLevel: field.int().default(0),
      lastError: field.text().optional(),
      activatedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Customer-facing invoice for a checkout. One row per payment
  // (`paymentId` unique): DRAFT at initiation, PAID once a validated
  // payment confirms, VOID when the payment terminally fails. The invoice
  // never drives activation — only a server-validated payment does.
  const Invoice = model('Invoice', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      paymentId: field.uuidString().unique(),
      invoiceNumber: field.text().unique(),
      planCode: field.text(),
      amountMinor: field.int(),
      currency: field.text().default('BDT'),
      status: field.text().default('DRAFT'),
      periodStart: field.temporal.timestamptzString().optional(),
      periodEnd: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Tenant-owned CRM resource. `businessId` is mandatory and every query
  // MUST filter by it — never by bare id (see src/lib/tenancy/leads.ts).
  // Lifecycle: active rows have `archivedAt === null`; archiving is a
  // soft-delete (requires leads.delete) and never exposes data cross-tenant.
  // (businessId, facebookLeadId) is unique so Meta redeliveries can never
  // create duplicate leads (NULL facebookLeadId rows are unaffected, since
  // Postgres treats NULLs as distinct).
  const Lead = model('Lead', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      name: field.text(),
      email: field.text().optional(),
      phone: field.text().optional(),
      status: field.text().default('NEW'),
      source: field.text().optional(),
      campaignName: field.text().optional(),
      adSetName: field.text().optional(),
      adName: field.text().optional(),
      facebookLeadId: field.text().optional(),
      assignedTo: field.uuidString().optional(),
      lastContactedAt: field.temporal.timestamptzString().optional(),
      nextFollowUpAt: field.temporal.timestamptzString().optional(),
      archivedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.facebookLeadId])],
  }));

  // WhatsApp Cloud API connection, one per business. Tenant-owned via
  // unique `businessId`. Stores only required metadata: the WABA id, phone
  // number id, display details, and the system-user access token as
  // AES-256-GCM ciphertext (see src/lib/integrations/whatsapp/). Health is
  // checked live against Meta; the last result is cached for display.
  const WhatsAppConnection = model('WhatsAppConnection', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString().unique(),
      wabaId: field.text(),
      phoneNumberId: field.text(),
      displayPhoneNumber: field.text().optional(),
      verifiedName: field.text().optional(),
      accessTokenEncrypted: field.text(),
      healthStatus: field.text().optional(),
      lastCheckedAt: field.temporal.timestamptzString().optional(),
      status: field.text().default('ACTIVE'),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });
  // Inbound Meta leadgen webhook event (outbox). One row per
  // (businessId, leadgenId); the unique constraint is the idempotency
  // key — concurrent redeliveries collapse to a single row.
  // Statuses: PENDING (queued) | PROCESSING (claimed by a worker) |
  // DONE (CRM lead created) | FAILED (terminal or awaiting retry — see
  // attempts/nextRetryAt). Webhook routing resolves the business from the
  // connected MetaForm; page/adgroup/ad ids are stored for attribution.
  const MetaLeadEvent = model('MetaLeadEvent', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadgenId: field.text(),
      metaPageId: field.text(),
      metaFormId: field.text(),
      adId: field.text().optional(),
      adgroupId: field.text().optional(),
      leadId: field.uuidString().optional(),
      status: field.text().default('PENDING'),
      attempts: field.int().default(0),
      lastError: field.text().optional(),
      nextRetryAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.leadgenId])],
  }));

  // Append-only timeline event for a lead. `businessId` is mandatory and
  // every query MUST filter by it (see src/lib/tenancy/activities.ts).
  // `type` is one of the LEAD_ACTIVITY_TYPES catalog
  // (CREATED | ASSIGNED | STATUS_CHANGED | NOTE_ADDED |
  // FOLLOW_UP_CREATED | FOLLOW_UP_COMPLETED | WHATSAPP_SENT |
  // WHATSAPP_RECEIVED as plain text). `body` carries human-readable detail
  // (note excerpt, status transition, message snippet). `actorId` is the
  // user who performed the activity; null for system/webhook events.
  const LeadActivity = model('LeadActivity', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadId: field.uuidString(),
      type: field.text(),
      body: field.text().optional(),
      actorId: field.uuidString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Agent note on a lead. Tenant-owned like LeadActivity; writing a note
  // also appends a NOTE_ADDED LeadActivity row (same business + lead).
  const LeadNote = model('LeadNote', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadId: field.uuidString(),
      authorId: field.uuidString(),
      body: field.text(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Scheduled follow-up for a lead. Tenant-owned: `businessId` is mandatory
  // and every query MUST filter by it (see src/lib/tenancy/followups.ts).
  // Stored statuses are PENDING | COMPLETED | CANCELLED; OVERDUE is derived
  // at read time (PENDING with scheduledAt in the past) so no cron is
  // needed to surface overdue items.
  const FollowUp = model('FollowUp', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadId: field.uuidString(),
      assignedTo: field.uuidString().optional(),
      scheduledAt: field.temporal.timestamptzString(),
      status: field.text().default('PENDING'),
      note: field.text().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Meta (Facebook Lead Ads) OAuth connection, one per business.
  // Tenant-owned: `businessId` is unique and every query MUST filter by it
  // (see src/lib/integrations/meta/service.ts). The access token is stored
  // ONLY as AES-256-GCM ciphertext (`accessTokenEncrypted`) — never plaintext,
  // never in logs, never in API responses.
  const MetaConnection = model('MetaConnection', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString().unique(),
      metaUserId: field.text(),
      metaUserName: field.text().optional(),
      accessTokenEncrypted: field.text(),
      tokenExpiresAt: field.temporal.timestamptzString().optional(),
      scopes: field.text(),
      status: field.text().default('ACTIVE'),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // Cached WhatsApp message template. Tenant-owned via
  // (businessId, name, language) — Meta allows the same name in multiple
  // languages. Only required metadata is stored: identity, category,
  // review status, and the raw components JSON (needed for preview and
  // variable extraction). Refreshed from Meta by template sync; never
  // hand-edited. Only APPROVED templates may be selected for sending.
  const WhatsAppTemplate = model('WhatsAppTemplate', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      wabaId: field.text(),
      name: field.text(),
      language: field.text(),
      category: field.text().optional(),
      status: field.text(),
      componentsJson: field.text(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.name, fields.language])],
  }));

  // A lead's selected WhatsApp template (at most one per lead). Stores the
  // template name + language snapshot used by future send steps; resolved
  // against synced templates at select time.
  const LeadTemplateSelection = model('LeadTemplateSelection', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadId: field.uuidString(),
      templateName: field.text(),
      templateLanguage: field.text(),
      selectedBy: field.uuidString(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.leadId])],
  }));

  // Outbound WhatsApp message (DB-backed outbox/queue — no worker infra in
  // this service, so enqueue + inline drain; see src/lib/integrations/
  // whatsapp/messages.ts) plus inbound replies and delivery receipts (see
  // src/lib/integrations/whatsapp/inbound.ts). One row per send attempt
  // batch: QUEUED on enqueue, SENDING while claimed, SENT with Meta's wamid
  // on acceptance, FAILED with attempts/lastError/nextRetryAt otherwise,
  // then DELIVERED / READ via status webhooks. Inbound rows use
  // direction=inbound, type=text (or the Meta message type), body=decoded
  // text, fromPhone=customer wa_id, toPhone=business display number, and
  // messageId=Meta wamid with status RECEIVED. Meta only *accepts*
  // messages here — delivery/read receipts arrive via webhooks later, so
  // frontend must poll status, never trust the send response.
  // `leadId` is nullable so unmatched inbound (unknown sender, ambiguous
  // match) persists gracefully with leadId=null instead of being assigned
  // to the wrong lead. (businessId, messageId) is unique so Meta
  // redeliveries collapse to one row (NULL messageIds — unsent outbound —
  // are unaffected, since Postgres treats NULLs as distinct).
  const WhatsAppMessage = model('WhatsAppMessage', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      leadId: field.uuidString().optional(),
      direction: field.text().default('outbound'),
      type: field.text().default('template'),
      templateName: field.text().optional(),
      templateLanguage: field.text().optional(),
      variablesJson: field.text().optional(),
      body: field.text().optional(),
      fromPhone: field.text().optional(),
      toPhone: field.text(),
      messageId: field.text().optional(),
      status: field.text().default('QUEUED'),
      attempts: field.int().default(0),
      lastError: field.text().optional(),
      nextRetryAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.messageId])],
  }));
  // Cached Facebook Pages for a connected workspace. Tenant-owned via
  // `businessId` (unique per business + page). Only required metadata is
  // stored: the Page id/name, granted tasks, and the Page access token as
  // AES-256-GCM ciphertext (needed for form listing + webhook subscription).
  // `selectedAt` marks the single active Page per business (null = not
  // selected); it also serves as the selection date for the UI.
  const MetaPage = model('MetaPage', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      metaPageId: field.text(),
      name: field.text(),
      pageTokenEncrypted: field.text(),
      tasks: field.text(),
      selectedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.metaPageId])],
  }));

  // Connected lead form for a workspace (at most one). Only required
  // metadata is stored: form/page ids, name, Meta status, and the
  // connection date. Webhook routing uses (businessId, metaFormId).
  const MetaForm = model('MetaForm', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      metaPageId: field.text(),
      metaFormId: field.text(),
      name: field.text(),
      status: field.text(),
      connectedAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.metaFormId])],
  }));

  // Automation rule: declarative trigger → actions config per workspace.
  // Tenant-owned via `businessId`. `trigger` is one of NEW_LEAD |
  // NO_CONTACT_AFTER_TIME | STATUS_CHANGED_TO_INTERESTED (see
  // src/lib/automation/engine.ts). `status` is ENABLED | DISABLED and is
  // the enable/disable switch. `configJson` carries the per-trigger
  // settings (follow-up delay, template selection, no-contact window,
  // assign strategy, notify text) as JSON text. Seeded with workspace
  // defaults on business creation; fully editable via the automations API.
  // (businessId, trigger, name) is unique so default seeding is
  // idempotent and duplicate rule names collapse.
  const AutomationRule = model('AutomationRule', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      trigger: field.text(),
      name: field.text(),
      status: field.text().default('ENABLED'),
      configJson: field.text(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.trigger, fields.name])],
  }));

  // Automation job (queue row). One row per (business, dedupeKey); the
  // unique constraint is the idempotency key — concurrent enqueues of the
  // same trigger+lead collapse to a single row. Statuses: QUEUED (awaiting
  // execution) | SENDING (claimed by a worker) | DONE (all actions
  // executed) | FAILED (terminal or awaiting retry — see
  // attempts/lastError/nextRetryAt). Redis carries only a wake-up signal;
  // the row is the source of truth, so execution stays retry-safe even
  // when Redis is unreachable.
  const AutomationJob = model('AutomationJob', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      ruleId: field.uuidString().optional(),
      trigger: field.text(),
      leadId: field.uuidString(),
      dedupeKey: field.text(),
      payloadJson: field.text().optional(),
      status: field.text().default('QUEUED'),
      attempts: field.int().default(0),
      lastError: field.text().optional(),
      nextRetryAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.dedupeKey])],
  }));

  // Append-only automation log. One row per executed action (automation
  // logs) — failures carry status FAILED with the error in `detail`
  // (failure logs). `action` is one of ASSIGN_AGENT | CREATE_FOLLOWUP |
  // SEND_WHATSAPP | NOTIFY_AGENT | CREATE_REMINDER. Skipped actions
  // (disabled rule, missing phone/template) are recorded as SKIPPED so
  // operators can see why nothing happened.
  const AutomationLog = model('AutomationLog', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      ruleId: field.uuidString().optional(),
      jobId: field.uuidString().optional(),
      leadId: field.uuidString().optional(),
      trigger: field.text(),
      action: field.text(),
      status: field.text(),
      detail: field.text().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  });

  // In-app notification. One row per recipient: `userId` is the member who
  // sees it, so role-aware delivery is a fan-out decision at emit time
  // (assignee-only for assignments, managers-only for connection/billing
  // failures — see src/lib/tenancy/notifications.ts). `type` is one of the
  // NOTIFICATION_TYPES catalog (LEAD_ASSIGNED | FOLLOWUP_DUE |
  // FOLLOWUP_OVERDUE | WHATSAPP_FAILED | FACEBOOK_EXPIRED |
  // PAYMENT_FAILED as plain text). `readAt === null` means unread.
  // `dedupeKey` makes recurring syncs idempotent (NULL keys are
  // unaffected, since Postgres treats NULLs as distinct); the unique
  // scope includes `userId` because one event fans out to many recipients.
  const Notification = model('Notification', {
    fields: {
      id: field.id.uuidv7String(),
      businessId: field.uuidString(),
      userId: field.uuidString(),
      type: field.text(),
      title: field.text(),
      body: field.text().optional(),
      leadId: field.uuidString().optional(),
      dedupeKey: field.text().optional(),
      readAt: field.temporal.timestamptzString().optional(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.businessId, fields.userId, fields.dedupeKey])],
  }));

  return {
    models: {
      User: User.relations({
        sessions: rel.hasMany(Session, { by: 'userId' }),
        passwordResetTokens: rel.hasMany(PasswordResetToken, { by: 'userId' }),
        ownedBusinesses: rel.hasMany(Business, { by: 'ownerId' }),
        memberships: rel.hasMany(BusinessMember, { by: 'userId' }),
      }),
      Session: Session.relations({
        user: rel.belongsTo(User, { from: 'userId', to: 'id' }),
      }),
      PasswordResetToken: PasswordResetToken.relations({
        user: rel.belongsTo(User, { from: 'userId', to: 'id' }),
      }),
      Business: Business.relations({
        owner: rel.belongsTo(User, { from: 'ownerId', to: 'id' }),
        members: rel.hasMany(BusinessMember, { by: 'businessId' }),
        leads: rel.hasMany(Lead, { by: 'businessId' }),
        leadActivities: rel.hasMany(LeadActivity, { by: 'businessId' }),
        leadNotes: rel.hasMany(LeadNote, { by: 'businessId' }),
        followUps: rel.hasMany(FollowUp, { by: 'businessId' }),
        metaConnections: rel.hasMany(MetaConnection, { by: 'businessId' }),
        metaPages: rel.hasMany(MetaPage, { by: 'businessId' }),
        metaForms: rel.hasMany(MetaForm, { by: 'businessId' }),
        metaLeadEvents: rel.hasMany(MetaLeadEvent, { by: 'businessId' }),
        automationRules: rel.hasMany(AutomationRule, { by: 'businessId' }),
        automationJobs: rel.hasMany(AutomationJob, { by: 'businessId' }),
        automationLogs: rel.hasMany(AutomationLog, { by: 'businessId' }),
        notifications: rel.hasMany(Notification, { by: 'businessId' }),
        subscriptions: rel.hasMany(Subscription, { by: 'businessId' }),
        payments: rel.hasMany(Payment, { by: 'businessId' }),
        invoices: rel.hasMany(Invoice, { by: 'businessId' }),
        whatsappMessages: rel.hasMany(WhatsAppMessage, { by: 'businessId' }),
        whatsappConnections: rel.hasMany(WhatsAppConnection, { by: 'businessId' }),
        whatsappTemplates: rel.hasMany(WhatsAppTemplate, { by: 'businessId' }),
        leadTemplateSelections: rel.hasMany(LeadTemplateSelection, { by: 'businessId' }),
      }),
      BusinessMember: BusinessMember.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        user: rel.belongsTo(User, { from: 'userId', to: 'id' }),
      }),
      Plan: Plan.relations({}),
      Subscription: Subscription.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      Payment: Payment.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      Invoice: Invoice.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      Role: Role.relations({
        rolePermissions: rel.hasMany(RolePermission, { by: 'roleId' }),
      }),
      Permission: Permission.relations({
        rolePermissions: rel.hasMany(RolePermission, { by: 'permissionId' }),
      }),
      RolePermission: RolePermission.relations({
        role: rel.belongsTo(Role, { from: 'roleId', to: 'id' }),
        permission: rel.belongsTo(Permission, { from: 'permissionId', to: 'id' }),
      }),
      Lead: Lead.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        activities: rel.hasMany(LeadActivity, { by: 'leadId' }),
        notes: rel.hasMany(LeadNote, { by: 'leadId' }),
        followUps: rel.hasMany(FollowUp, { by: 'leadId' }),
      }),
      LeadActivity: LeadActivity.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        lead: rel.belongsTo(Lead, { from: 'leadId', to: 'id' }),
      }),
      LeadNote: LeadNote.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        lead: rel.belongsTo(Lead, { from: 'leadId', to: 'id' }),
      }),
      FollowUp: FollowUp.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        lead: rel.belongsTo(Lead, { from: 'leadId', to: 'id' }),
      }),
      MetaConnection: MetaConnection.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      MetaPage: MetaPage.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      MetaForm: MetaForm.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      MetaLeadEvent: MetaLeadEvent.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      AutomationRule: AutomationRule.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      AutomationJob: AutomationJob.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      AutomationLog: AutomationLog.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      Notification: Notification.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      WhatsAppConnection: WhatsAppConnection.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      WhatsAppMessage: WhatsAppMessage.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        lead: rel.belongsTo(Lead, { from: 'leadId', to: 'id' }),
      }),
      WhatsAppTemplate: WhatsAppTemplate.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
      }),
      LeadTemplateSelection: LeadTemplateSelection.relations({
        business: rel.belongsTo(Business, { from: 'businessId', to: 'id' }),
        lead: rel.belongsTo(Lead, { from: 'leadId', to: 'id' }),
      }),
    },
  };
});
