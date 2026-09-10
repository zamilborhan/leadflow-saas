/**
 * WhatsApp template parsing + preview helpers. Pure module (no imports)
 * so unit tests exercise it directly.
 *
 * Per Meta's template docs, variables appear as positional (`{{1}}`) or
 * named (`{{first_name}}`) placeholders in component text. Only APPROVED
 * templates may be sent; every other review status blocks sending.
 */

export interface TemplateVariable {
  /** Component the variable belongs to (HEADER, BODY, ...). */
  component: string;
  /** Positional index ({{1}} → 1) or named key ({{name}} → "name"). */
  key: string;
  /** True for {{1}}-style placeholders; false for {{name}}-style. */
  positional: boolean;
}

export interface PreviewLine {
  component: string;
  text: string;
}

const VARIABLE_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** True only for templates Meta allows sending (APPROVED). */
export function isSendableStatus(status: unknown): boolean {
  return status === "APPROVED";
}

/** Extract every variable placeholder from component text, in order. */
export function extractVariables(
  components: Array<{ type?: unknown; text?: unknown }>
): TemplateVariable[] {
  const out: TemplateVariable[] = [];
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const type = typeof component.type === "string" ? component.type : "UNKNOWN";
    if (typeof component.text !== "string") continue;
    VARIABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VARIABLE_RE.exec(component.text)) !== null) {
      const key = match[1];
      out.push({ component: type, key, positional: /^\d+$/.test(key) });
    }
  }
  return out;
}

/**
 * Render a text preview of template components, substituting provided
 * values (`{ "1": ..., "name": ... }`) and leaving unknown placeholders
 * intact. One line per text-bearing component, prefixed by its type.
 */
export function renderPreview(
  components: Array<{ type?: unknown; text?: unknown }>,
  values: Record<string, string> = {}
): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const type = typeof component.type === "string" ? component.type : "UNKNOWN";
    if (typeof component.text !== "string") continue;
    VARIABLE_RE.lastIndex = 0;
    const text = component.text.replace(VARIABLE_RE, (_whole, key: string) =>
      Object.hasOwn(values, key) ? values[key] : `{{${key}}}`
    );
    out.push({ component: type, text });
  }
  return out;
}

export class TemplateSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateSendError";
  }
}

export interface SendComponent {
  type: string;
  parameters: Array<Record<string, unknown>>;
}

/**
 * Build the send-API `components` array for a template: one entry per
 * text-bearing component with variables, each carrying ordered text
 * parameters (positional in placeholder order; named with parameter_name,
 * per Meta's send docs). Throws TemplateSendError listing every missing
 * or blank value — the route maps it to 422.
 */
export function buildSendComponents(
  components: Array<{ type?: unknown; text?: unknown }>,
  values: Record<string, string>
): SendComponent[] {
  const out: SendComponent[] = [];
  const missing: string[] = [];
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const type = typeof component.type === "string" ? component.type : null;
    // Only HEADER and BODY carry sendable text variables today.
    if (type !== "HEADER" && type !== "BODY") continue;
    if (typeof component.text !== "string") continue;
    const variables = extractVariables([component]);
    if (variables.length === 0) continue;
    const parameters: Array<Record<string, unknown>> = [];
    for (const v of variables) {
      const raw = values[v.key];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value) {
        missing.push(v.positional ? `${v.component} variable {{${v.key}}}` : `{{${v.key}}}`);
        continue;
      }
      parameters.push(
        v.positional
          ? { type: "text", text: value.slice(0, 1024) }
          : { type: "text", parameter_name: v.key, text: value.slice(0, 1024) }
      );
    }
    out.push({ type: type.toLowerCase(), parameters });
  }
  if (missing.length > 0) {
    throw new TemplateSendError(`Missing values for: ${missing.join(", ")}.`);
  }
  return out;
}
