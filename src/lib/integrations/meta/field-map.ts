/**
 * Map Meta lead field_data into CRM lead input. Pure module (no imports)
 * so unit tests exercise it directly.
 *
 * Meta question keys vary by form locale/template (full_name vs
 * first_name/last_name, email vs work_email, phone vs phone_number…), so
 * matching is case-insensitive over a curated alias list. Values are
 * trimmed and clamped to the CRM column limits (mirroring validation.ts);
 * an unusable email is dropped rather than failing the whole lead, and a
 * missing name falls back to "Facebook Lead" so ingestion never loses a
 * prospect over a blank answer.
 */

export interface MappedLead {
  name: string;
  email?: string;
  phone?: string;
}

export interface MetaFieldDatum {
  name: string;
  values: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FULL_NAME_KEYS = ["full_name", "name", "lead_name", "contact_name"];
const EMAIL_KEYS = ["email", "work_email", "email_address"];
const PHONE_KEYS = [
  "phone",
  "phone_number",
  "phone_otp",
  "work_phone_number",
  "user_provided_phone_number",
  "whatsapp_number",
  "mobile",
  "mobile_number",
  "contact_number",
];

function firstValue(data: MetaFieldDatum[], keys: string[]): string | null {
  const wanted = new Set(keys);
  for (const datum of data) {
    if (!datum || typeof datum.name !== "string") continue;
    if (!wanted.has(datum.name.trim().toLowerCase())) continue;
    if (!Array.isArray(datum.values)) continue;
    for (const v of datum.values) {
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return null;
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Normalize raw Graph field_data entries (tolerates junk entries). */
export function normalizeFieldData(raw: unknown): MetaFieldDatum[] {
  if (!Array.isArray(raw)) return [];
  const out: MetaFieldDatum[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["name"] !== "string") continue;
    const values = Array.isArray(rec["values"])
      ? rec["values"].filter((v): v is string => typeof v === "string")
      : [];
    out.push({ name: rec["name"], values });
  }
  return out;
}

export function mapLeadFields(rawFieldData: unknown): MappedLead {
  const data = normalizeFieldData(rawFieldData);

  let name = firstValue(data, FULL_NAME_KEYS) ?? "";
  if (!name) {
    const first = firstValue(data, ["first_name"]) ?? "";
    const last = firstValue(data, ["last_name"]) ?? "";
    name = `${first} ${last}`.trim() || first || last;
  }
  if (!name) name = "Facebook Lead";

  const mapped: MappedLead = { name: clamp(name, 200) };

  const email = firstValue(data, EMAIL_KEYS);
  if (email && EMAIL_RE.test(email.toLowerCase())) {
    mapped.email = email.toLowerCase().slice(0, 254);
  }
  const phone = firstValue(data, PHONE_KEYS);
  if (phone) {
    mapped.phone = clamp(phone, 40);
  }
  return mapped;
}
