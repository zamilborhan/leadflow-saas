import {
  cloneElement,
  forwardRef,
  isValidElement,
  type InputHTMLAttributes,
  type ReactNode,
  useId,
} from "react";
import { cn } from "@/src/lib/cn";

export const INPUT_BASE =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:border-red-500 aria-[invalid=true]:hover:border-red-500";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/** Accessible text input. Pair with Field for label/error wiring. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(INPUT_BASE, "h-10", className)}
      {...rest}
    />
  );
});

interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}

/**
 * Accessible field wrapper: links label, hint, and error to the control via
 * aria-describedby. The control must accept an `id` prop.
 */
export function Field({ label, htmlFor, hint, error, required, children }: FieldProps) {
  const autoId = useId();
  const controlId = htmlFor ?? `field-${autoId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={controlId} className="text-sm font-medium text-slate-700">
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-red-600">
            *
          </span>
        ) : null}
      </label>
      {childrenWithId(children, controlId, describedBy, Boolean(error))}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function childrenWithId(
  children: ReactNode,
  id: string,
  describedBy: string | undefined,
  invalid: boolean
): ReactNode {
  // Attach id + describedby wiring to the single control child.
  if (isValidElement<{ id?: string; ["aria-describedby"]?: string; invalid?: boolean }>(children)) {
    return cloneElement(children, { id, "aria-describedby": describedBy, invalid });
  }
  return children;
}
