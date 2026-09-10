import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/src/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Surface container: white card, subtle border + shadow. */
export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div className={cn("rounded-xl border border-slate-200 bg-white shadow-sm", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children, ...rest }: CardProps) {
  return (
    <div className={cn("border-b border-slate-100 px-5 py-4 sm:px-6", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: CardProps) {
  return (
    <h3 className={cn("text-base font-semibold text-slate-900", className)} {...rest}>
      {children}
    </h3>
  );
}

export function CardDescription({ className, children, ...rest }: CardProps) {
  return (
    <p className={cn("mt-1 text-sm text-slate-500", className)} {...rest}>
      {children}
    </p>
  );
}

export function CardContent({ className, children, ...rest }: CardProps) {
  return (
    <div className={cn("px-5 py-5 sm:px-6", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn("flex flex-col gap-3 border-t border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6", className)}
      {...rest}
    >
      {children}
    </div>
  );
}
