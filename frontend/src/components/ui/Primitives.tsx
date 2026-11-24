import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Loader2, X, AlertTriangle } from 'lucide-react';
import { humanizeKey } from '@/lib/format';

/* -------------------- STATUS BADGE -------------------- */
const STATUS_STYLES: Record<string, string> = {
  // Positive / Approved / Published
  approved: 'bg-teal-tint text-teal-accent border-teal-border/70',
  published: 'bg-teal-tint text-teal-accent border-teal-border/70',
  completed: 'bg-teal-tint text-teal-accent border-teal-border/70',
  resolved: 'bg-teal-tint text-teal-accent border-teal-border/70',
  synced: 'bg-teal-tint text-teal-accent border-teal-border/70',
  validated: 'bg-teal-tint text-teal-accent border-teal-border/70',
  active: 'bg-teal-tint text-teal-accent border-teal-border/70',

  // Warning / Flagged / Pending / Queued
  flagged: 'bg-amber-tint text-amber-warn border-amber-border/50',
  warning: 'bg-amber-tint text-amber-warn border-amber-border/50',
  open: 'bg-amber-tint text-amber-warn border-amber-border/50',
  retrying: 'bg-amber-tint text-amber-warn border-amber-border/50',
  local_saved: 'bg-amber-tint text-amber-warn border-amber-border/50',
  paused: 'bg-amber-tint text-amber-warn border-amber-border/50',
  processing: 'bg-sky-50 text-sky-800 border-sky-200',
  syncing: 'bg-sky-50 text-sky-800 border-sky-200',
  queued: 'bg-slate-100 text-navy-600 border-hairlineStrong',
  ingested: 'bg-slate-100 text-navy-600 border-hairlineStrong',
  draft: 'bg-recessed text-navy-600 border-hairlineStrong',
  retired: 'bg-recessed text-navy-500 border-hairline',
  archived: 'bg-recessed text-navy-500 border-hairline',
  dismissed: 'bg-recessed text-navy-500 border-hairline',
  info: 'bg-slate-100 text-navy-600 border-hairlineStrong',

  // Critical errors ONLY
  rejected: 'bg-crimson-tint text-crimson-err border-crimson-border/60',
  critical: 'bg-crimson-tint text-crimson-err border-crimson-border/60',
  failed: 'bg-crimson-tint text-crimson-err border-crimson-border/60',
};

export function StatusBadge({
  status,
  label,
  className = '',
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  const key = (status || '').toLowerCase();
  const tone = STATUS_STYLES[key] || 'bg-recessed text-navy-600 border-hairlineStrong';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap ${tone} ${className}`}
    >
      {label || humanizeKey(status || 'unknown')}
    </span>
  );
}

/* -------------------- KPI CELL -------------------- */
export function KpiCell({
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  sublabel?: string;
  tone?: 'default' | 'teal' | 'amber' | 'crimson';
}) {
  const valColor = {
    default: 'text-navy',
    teal: 'text-teal-accent',
    amber: 'text-amber-warn',
    crimson: 'text-crimson-err',
  }[tone];

  return (
    <div className="ops-surface px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-navy-500">{label}</div>
      <div className={`mt-1 text-[22px] font-semibold leading-tight tracking-tight tabular-nums ${valColor}`}>
        {value}
      </div>
      {sublabel && <div className="mt-1 text-[11.5px] text-navy-500 tabular-nums">{sublabel}</div>}
    </div>
  );
}

/* -------------------- PAGE HEADER -------------------- */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-[18px] font-semibold tracking-tight text-navy">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-navy-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/* -------------------- STATES -------------------- */
export function LoadingState({ message = 'Loading operational records...' }: { message?: string }) {
  return (
    <div className="ops-surface flex items-center justify-center gap-2.5 px-6 py-12 text-[13px] text-navy-500">
      <Loader2 className="h-4 w-4 animate-spin text-teal-accent" />
      <span>{message}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="ops-surface flex flex-col items-center justify-center gap-2 border-crimson-border/60 bg-crimson-tint/20 px-6 py-10 text-center">
      <AlertCircle className="h-5 w-5 text-crimson-err" />
      <div className="text-[13.5px] font-medium text-navy">Unable to load data</div>
      <p className="max-w-md text-[12.5px] text-navy-600">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="ops-btn-secondary mt-2">
          Retry request
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="ops-surface flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-[14px] font-medium text-navy">{title}</div>
      <p className="mt-1 max-w-md text-[12.5px] text-navy-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -------------------- PAGINATION BAR -------------------- */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (nextPage: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);

  return (
    <div className="flex items-center justify-between border-t border-hairline bg-canvas/50 px-3 py-2 text-[12px] text-navy-500">
      <div className="tabular-nums">
        Showing <span className="font-medium text-navy">{start}–{end}</span> of{' '}
        <span className="font-medium text-navy">{total.toLocaleString()}</span> records
      </div>
      <div className="flex items-center gap-1.5">
        <button
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="ops-btn-secondary px-2 py-1 text-[12px]"
        >
          Previous
        </button>
        <span className="px-2 tabular-nums">
          Page {page} / {totalPages}
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="ops-btn-secondary px-2 py-1 text-[12px]"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/* -------------------- MODAL -------------------- */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  maxWidth = 'max-w-xl',
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-navy/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={`w-full ${maxWidth} rounded border border-hairlineStrong bg-surface shadow-popover`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-hairline px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold text-navy">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] text-navy-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm p-1 text-navy-500 hover:bg-recessed hover:text-navy"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[78vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

/* -------------------- CONFIRM MODAL -------------------- */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  isPending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  isPending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel} maxWidth="max-w-md">
      <p className="text-[13px] text-navy-600 leading-relaxed">{message}</p>
      <div className="mt-4 flex justify-end gap-2 border-t border-hairline pt-3">
        <button type="button" onClick={onCancel} disabled={isPending} className="ops-btn-secondary">
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isPending}
          className={tone === 'danger' ? 'ops-btn-danger' : 'ops-btn-primary'}
        >
          {isPending ? 'Working...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* -------------------- TOAST SYSTEM -------------------- */
interface ToastMessage {
  id: string;
  tone: 'success' | 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
}

const ToastContext = createContext<{
  pushToast: (toast: Omit<ToastMessage, 'id'>) => void;
} | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <div className="fixed bottom-16 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 sm:bottom-4">
        {toasts.map((t) => {
          const Icon =
            t.tone === 'success'
              ? CheckCircle2
              : t.tone === 'error'
              ? AlertCircle
              : t.tone === 'warning'
              ? AlertTriangle
              : Info;
          const borderTone =
            t.tone === 'success'
              ? 'border-l-teal-accent'
              : t.tone === 'error'
              ? 'border-l-crimson-err'
              : t.tone === 'warning'
              ? 'border-l-amber-warn'
              : 'border-l-navy';
          return (
            <div
              key={t.id}
              className={`flex items-start gap-2.5 rounded-sm border border-hairlineStrong border-l-[3px] ${borderTone} bg-surface p-3 shadow-popover`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-navy-600" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold text-navy">{t.title}</div>
                {t.detail && <div className="mt-0.5 text-[11.5px] text-navy-500">{t.detail}</div>}
              </div>
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="text-navy-400 hover:text-navy"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
