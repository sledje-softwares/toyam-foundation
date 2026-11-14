import Link from "next/link";
import { buttonClass } from "./button";

export function EmptyState({
  title,
  description,
  action,
  filtered = false,
}: {
  title: string;
  description?: string;
  action?: { label: string; href: string };
  /** True when the list is empty because of filters: offers to clear them. */
  filtered?: boolean;
}) {
  return (
    <div className="rounded border border-dashed border-border-input bg-surface px-6 py-10 text-center">
      <p className="text-base font-medium">{filtered ? "No results for these filters" : title}</p>
      {(filtered || description) && (
        <p className="mt-1 text-sm text-text-muted">{filtered ? "Change or clear the filters to see more." : description}</p>
      )}
      {action && !filtered && (
        <div className="mt-4">
          <Link href={action.href} className={buttonClass("primary")}>
            {action.label}
          </Link>
        </div>
      )}
    </div>
  );
}
