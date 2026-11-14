const STYLES = {
  info: "border-blue-300 bg-primary-soft text-blue-900",
  warning: "border-amber-300 bg-warning-soft text-warning",
  danger: "border-red-300 bg-danger-soft text-danger",
} as const;

export function InlineAlert({
  tone = "info",
  title,
  children,
}: {
  tone?: keyof typeof STYLES;
  title?: string;
  children?: React.ReactNode;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "note"} className={`rounded border px-4 py-3 text-sm ${STYLES[tone]}`}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={title ? "mt-1" : ""}>{children}</div>}
    </div>
  );
}
