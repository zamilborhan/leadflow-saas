import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/src/lib/cn";

/**
 * Responsive data table. Horizontally scrolls on small screens; use semantic
 * th/td via the subcomponents so screen readers get proper headers.
 */
export function Table({ className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={cn("overflow-x-auto", className)} {...rest}>
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function TableHeader({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn("border-b border-slate-200 bg-slate-50", className)} {...rest}>
      {children}
    </thead>
  );
}

export function TableBody({ className, children, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cn("divide-y divide-slate-100 bg-white", className)} {...rest}>
      {children}
    </tbody>
  );
}

export function TableRow({ className, children, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn("transition-colors hover:bg-slate-50", className)} {...rest}>
      {children}
    </tr>
  );
}

export function TableHead({ className, children, scope = "col", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cn("whitespace-nowrap px-4 py-3 text-xs font-semibold tracking-wide text-slate-500 uppercase first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6", className)}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableCell({ className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn("px-4 py-3.5 text-slate-700 first:pl-5 last:pr-5 sm:first:pl-6 sm:last:pr-6", className)} {...rest}>
      {children}
    </td>
  );
}
