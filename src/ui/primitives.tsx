import { useEffect, useRef, useState, type ReactNode } from "react";

export function IconButton({
  onClick, title, children, active = false, disabled = false, accent = false,
}: {
  onClick?: () => void;
  title: string;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={[
        "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400",
        disabled
          ? "cursor-not-allowed text-zinc-600"
          : accent
            ? "bg-sky-600 text-white hover:bg-sky-500"
            : active
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Menu({
  label, children, width = "w-64",
}: { label: ReactNode; children: ReactNode; width?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        aria-expanded={open}
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60">
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute left-0 top-9 z-50 ${width} rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/50`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick, children, hint,
}: { onClick?: () => void; children: ReactNode; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] text-zinc-200 hover:bg-zinc-800"
    >
      <span>{children}</span>
      {hint && <span className="pl-4 text-[11px] text-zinc-500">{hint}</span>}
    </button>
  );
}

export function Modal({
  title, onClose, children,
}: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
