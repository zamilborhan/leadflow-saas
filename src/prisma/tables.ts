/**
 * Model collection accessors.
 *
 * The installed ORM runtime addresses models by namespace coordinate
 * (`db.orm.public.User`), not by bare name (`db.orm.User` returns undefined).
 * Every query in the app goes through these accessors so the coordinate lives
 * in exactly one place.
 */
import { db } from "./db";

export const UserTable = db.orm.public.User;
export const SessionTable = db.orm.public.Session;
export const PasswordResetTokenTable = db.orm.public.PasswordResetToken;
export const BusinessTable = db.orm.public.Business;
export const BusinessMemberTable = db.orm.public.BusinessMember;
export const RoleTable = db.orm.public.Role;
export const PermissionTable = db.orm.public.Permission;
export const RolePermissionTable = db.orm.public.RolePermission;
export const LeadTable = db.orm.public.Lead;
export const LeadActivityTable = db.orm.public.LeadActivity;
export const LeadNoteTable = db.orm.public.LeadNote;
export const FollowUpTable = db.orm.public.FollowUp;
export const MetaConnectionTable = db.orm.public.MetaConnection;
export const MetaPageTable = db.orm.public.MetaPage;
export const MetaFormTable = db.orm.public.MetaForm;
export const MetaLeadEventTable = db.orm.public.MetaLeadEvent;
export const WhatsAppConnectionTable = db.orm.public.WhatsAppConnection;
export const WhatsAppMessageTable = db.orm.public.WhatsAppMessage;
export const WhatsAppTemplateTable = db.orm.public.WhatsAppTemplate;
export const LeadTemplateSelectionTable = db.orm.public.LeadTemplateSelection;
export const AutomationRuleTable = db.orm.public.AutomationRule;
export const AutomationJobTable = db.orm.public.AutomationJob;
export const AutomationLogTable = db.orm.public.AutomationLog;
export const NotificationTable = db.orm.public.Notification;
export const PlanTable = db.orm.public.Plan;
export const SubscriptionTable = db.orm.public.Subscription;
export const PaymentTable = db.orm.public.Payment;
export const InvoiceTable = db.orm.public.Invoice;
