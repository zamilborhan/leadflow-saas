# LeadFlow BD — Product Specification

## Product

Bangladesh-focused multi-tenant SaaS for businesses that generate leads from
Meta/Facebook Lead Ads. LeadFlow captures leads automatically, organizes them
in a CRM, assigns them to sales agents, enables WhatsApp follow-up with
approved templates, creates follow-up reminders, automates follow-up
workflows, and reports lead-to-sale conversion.

## Target customers

- Coaching centers / IELTS centers
- Education and visa/study-abroad consultancies
- Real estate companies
- Clinics
- Other Bangladesh businesses using Facebook lead generation

## Core problem

Businesses receive Facebook leads but lose potential customers because:

- leads are not organized
- leads are not assigned properly
- sales agents forget follow-ups
- WhatsApp follow-up is inconsistent
- businesses cannot easily track lead-to-sale conversion

## MVP scope

1. Authentication
2. Business (workspace) management
3. Team members, roles and permissions
4. Lead CRM (statuses, assignment, notes, activity timeline)
5. Follow-up scheduling and reminders
6. Facebook/Meta OAuth, Page + Lead Form connection, Lead Ads webhook
7. Automatic lead import (attribution, duplicate prevention)
8. WhatsApp Cloud API (templates, outbound/inbound, status tracking)
9. Follow-up automation via Redis queues
10. Dashboard with basic conversion metrics
11. Subscription plans, billing, payments
12. Admin panel

The MVP is complete when a user can register, create a business, invite a
sales agent, connect a Meta lead source, receive a real/test lead, see it in
the CRM, assign it, send an approved WhatsApp template, schedule a follow-up,
view the activity timeline, and see basic conversion metrics.

## Non-goals (future)

AI lead scoring/summaries/replies, Instagram and Google Ads leads, email/SMS
automation, agency white-labeling, mobile app.

## Current phase

Project initialization only: tooling, docs, Docker, database connectivity.
No product features are implemented yet.
