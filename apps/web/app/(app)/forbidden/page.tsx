import Link from "next/link";

export default function Forbidden() {
  return (
    <div>
      <h1 className="text-2xl font-semibold">Access denied</h1>
      <p className="mt-2 text-slate-600">Your role does not have access to this page.</p>
      <Link href="/dashboard" className="mt-4 inline-block text-blue-800 underline">
        Back to dashboard
      </Link>
    </div>
  );
}
