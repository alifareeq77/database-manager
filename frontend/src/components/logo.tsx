export function Logo({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="4.2" rx="1.4" className="fill-brand" />
      <rect x="3" y="9.9" width="18" height="4.2" rx="1.4" className="fill-brand/60" />
      <rect x="3" y="15.8" width="18" height="4.2" rx="1.4" className="fill-brand/30" />
    </svg>
  );
}
