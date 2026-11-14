import Link from "next/link";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BASE =
  "inline-flex h-9 min-w-8 items-center justify-center gap-2 rounded px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "border border-border-input bg-surface text-text hover:bg-slate-100",
  danger: "bg-danger text-white hover:bg-danger-hover",
  ghost: "text-primary hover:bg-primary-soft",
};

export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `${BASE} ${VARIANTS[variant]} ${extra}`.trim();
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant };

export function Button({ variant = "primary", className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, className)} {...rest} />;
}

/** A link that looks like a button. */
export function ButtonLink({
  variant = "primary",
  className,
  ...rest
}: React.ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}
