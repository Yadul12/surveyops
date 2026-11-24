import React, { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Bell,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Database,
  FileText,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  ShieldAlert,
  Smartphone,
  User as UserIcon,
  Workflow,
  X,
} from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { LiveEventsProvider, useLiveEventsContext } from '@/hooks/useLiveEvents';
import { StatusBadge } from '@/components/ui/Primitives';
import { formatRelativeTime, humanizeKey } from '@/lib/format';
import type { NotificationItem } from '@/types';

const ROUTE_LABELS: Record<string, string> = {
  '': 'Operations Overview',
  surveys: 'Surveys',
  builder: 'Survey Builder',
  preview: 'Preview',
  assignments: 'Assignments',
  pipeline: 'Processing Pipeline',
  responses: 'Responses',
  quality: 'Data Quality Console',
  analytics: 'Analytics Workspace',
  reports: 'Insight Reports',
  scalability: 'Scale & Benchmarks',
  field: 'Field Agent App',
};

function AppShellInner() {
  const { user, logout, hasRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { connected } = useLiveEventsContext();

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const notifContainerRef = useRef<HTMLDivElement>(null);
  const profileContainerRef = useRef<HTMLDivElement>(null);

  // Close mobile drawer on route navigation
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Keyboard shortcuts & click-outside dismissal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
        setNotifOpen(false);
        setProfileOpen(false);
        setMobileNavOpen(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (notifContainerRef.current && !notifContainerRef.current.contains(target)) {
        setNotifOpen(false);
      }
      if (profileContainerRef.current && !profileContainerRef.current.contains(target)) {
        setProfileOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  useEffect(() => {
    if (searchOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 20);
    }
  }, [searchOpen]);

  const { data: searchData } = useQuery({
    queryKey: ['global-search', searchTerm],
    queryFn: () =>
      apiRequest<{
        surveys: Array<{ id: string; code: string; title: string; status: string }>;
        responses: Array<{ id: string; client_submission_id: string; survey_code: string; district: string; status: string }>;
        quality_issues: Array<{ id: string; response_id: string; issue_type: string; severity: string; message: string }>;
        reports: Array<{ id: string; title: string; report_type: string }>;
      }>('/search', { params: { q: searchTerm } }),
    enabled: searchOpen && searchTerm.trim().length >= 2,
  });

  const { data: notifData } = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      apiRequest<{ unread_count: number; items: NotificationItem[] }>('/notifications', { params: { limit: 20 } }),
    refetchInterval: 30000,
  });

  const markAllRead = useMutation({
    mutationFn: () => apiRequest('/notifications/read-all', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Build safe breadcrumbs (non-clickable UUID intermediate segments to avoid dead links)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const breadcrumbs = pathParts.map((part, idx) => {
    const to = '/' + pathParts.slice(0, idx + 1).join('/');
    const isUuid = /^[0-9a-f-]{20,}$/i.test(part);
    const label = ROUTE_LABELS[part] || (isUuid ? `ID ${part.slice(0, 8)}` : humanizeKey(part));
    return { to, label, clickable: !isUuid && idx < pathParts.length - 1 };
  });

  const navGroups = [
    {
      label: 'Operations',
      items: [
        { to: '/', label: 'Overview', icon: LayoutDashboard, exact: true, visible: true },
        { to: '/surveys', label: 'Surveys & Builder', icon: ClipboardList, exact: false, visible: true },
        { to: '/field', label: 'Field Agent App', icon: Smartphone, exact: false, visible: true },
      ],
    },
    {
      label: 'Data Operations',
      items: [
        { to: '/pipeline', label: 'Processing Pipeline', icon: Workflow, exact: false, visible: true },
        { to: '/responses', label: 'Response Registry', icon: Database, exact: false, visible: true },
        { to: '/quality', label: 'Data Quality Console', icon: ShieldAlert, exact: false, visible: hasRole('admin', 'analyst') },
      ],
    },
    {
      label: 'Intelligence',
      items: [
        { to: '/analytics', label: 'Analytics Workspace', icon: BarChart3, exact: false, visible: true },
        { to: '/reports', label: 'Insight Reports', icon: FileText, exact: false, visible: true },
        { to: '/scalability', label: 'Scale & Benchmarks', icon: Gauge, exact: false, visible: hasRole('admin', 'analyst') },
      ],
    },
  ];

  const renderSidebarContent = (showCloseButton: boolean) => (
    <>
      <div className="flex h-[52px] items-center justify-between border-b border-hairline px-4">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-sm bg-navy text-white">
            <Activity className="h-4 w-4 text-teal-border" />
          </div>
          <div>
            <div className="text-[14px] font-semibold leading-none tracking-tight text-navy">SurveyOps</div>
            <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-navy-400">
              Field Intelligence
            </div>
          </div>
        </Link>
        {showCloseButton && (
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="rounded-sm p-1 text-navy-500 hover:bg-canvas"
            aria-label="Close navigation menu"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-2.5 py-4" aria-label="Primary navigation">
        {navGroups.map((group) => {
          const visibleItems = group.items.filter((i) => i.visible);
          if (!visibleItems.length) return null;
          return (
            <div key={group.label}>
              <div className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {visibleItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.exact}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                          isActive
                            ? 'bg-teal-tint/80 text-teal-accent border-l-2 border-teal-accent'
                            : 'text-navy-600 hover:bg-canvas hover:text-navy'
                        }`
                      }
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-hairline px-3.5 py-2.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 font-medium text-navy-600">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-teal-accent' : 'bg-amber-border'}`} />
            {connected ? 'Live Stream Active' : 'Stream Reconnecting'}
          </span>
          <span className="font-mono text-[10.5px] text-navy-400">v1.0</span>
        </div>
        <div className="mt-1 truncate text-[11px] text-navy-400">{user?.department || 'Civic Operations'}</div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-canvas text-navy">
      {/* Desktop Fixed Sidebar (>= lg) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[236px] flex-col border-r border-hairline bg-surface lg:flex">
        {renderSidebarContent(false)}
      </aside>

      {/* Mobile / Tablet Slide-Over Drawer (< lg) */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div className="fixed inset-0 bg-navy/40" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative z-50 flex w-[256px] max-w-[82vw] flex-col border-r border-hairline bg-surface shadow-popover">
            {renderSidebarContent(true)}
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-[236px]">
        {/* Compact Top Navigation Bar */}
        <header className="sticky top-0 z-20 flex h-[52px] items-center justify-between gap-2 border-b border-hairline bg-surface/95 px-4 backdrop-blur-sm lg:px-6">
          {/* Left: Hamburger (< lg) + Breadcrumbs */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded-sm border border-hairline p-1.5 text-navy-600 hover:bg-canvas lg:hidden"
              aria-label="Open navigation menu"
            >
              <Menu className="h-4 w-4" />
            </button>

            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
              <Link to="/" className="hidden shrink-0 font-medium text-navy-500 hover:text-navy sm:inline">
                SurveyOps
              </Link>
              {breadcrumbs.length === 0 ? (
                <>
                  <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-navy-400 sm:inline" />
                  <span className="truncate font-semibold text-navy">Operations Overview</span>
                </>
              ) : (
                breadcrumbs.map((b, idx) => (
                  <React.Fragment key={b.to}>
                    <ChevronRight
                      className={`h-3.5 w-3.5 shrink-0 text-navy-400 ${idx === 0 ? 'hidden sm:inline' : ''}`}
                    />
                    {b.clickable ? (
                      <Link to={b.to} className="truncate text-navy-500 hover:text-navy whitespace-nowrap">
                        {b.label}
                      </Link>
                    ) : (
                      <span
                        className={`truncate whitespace-nowrap ${
                          idx === breadcrumbs.length - 1 ? 'font-semibold text-navy' : 'text-navy-400 font-mono text-[11.5px]'
                        }`}
                      >
                        {b.label}
                      </span>
                    )}
                  </React.Fragment>
                ))
              )}
            </nav>
          </div>

          {/* Right Utility Controls */}
          <div className="flex shrink-0 items-center gap-2">
            {/* Global Search Trigger */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Open global search"
              className="flex shrink-0 items-center gap-2 rounded-sm border border-hairlineStrong bg-canvas px-2.5 py-1 text-[12px] text-navy-500 whitespace-nowrap transition-colors hover:border-navy-400 hover:text-navy"
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden xl:inline">Search surveys, responses, issues...</span>
              <span className="hidden md:inline xl:hidden">Search...</span>
              <kbd className="hidden rounded border border-hairline bg-surface px-1 py-0.5 font-mono text-[10px] text-navy-400 sm:inline">
                ⌘K
              </kbd>
            </button>

            {/* Notifications */}
            <div className="relative" ref={notifContainerRef}>
              <button
                type="button"
                onClick={() => {
                  setNotifOpen((v) => !v);
                  setProfileOpen(false);
                }}
                aria-label="Notifications"
                aria-expanded={notifOpen}
                aria-haspopup="menu"
                className="relative rounded-sm border border-transparent p-1.5 text-navy-600 hover:border-hairline hover:bg-canvas hover:text-navy"
              >
                <Bell className="h-4 w-4" />
                {(notifData?.unread_count || 0) > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-warn px-1 text-[10px] font-semibold text-white tabular-nums">
                    {notifData!.unread_count > 99 ? '99+' : notifData!.unread_count}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1.5 w-[340px] max-w-[90vw] rounded border border-hairlineStrong bg-surface shadow-popover"
                >
                  <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
                    <span className="text-[12.5px] font-semibold text-navy">Operational Alerts</span>
                    <button
                      type="button"
                      onClick={() => markAllRead.mutate()}
                      disabled={markAllRead.isPending}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-accent hover:underline"
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                      Mark all read
                    </button>
                  </div>
                  <div className="max-h-80 divide-y divide-hairline overflow-y-auto">
                    {(notifData?.items || []).length === 0 ? (
                      <div className="px-4 py-6 text-center text-[12px] text-navy-500">No recent alerts.</div>
                    ) : (
                      (notifData?.items || []).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            setNotifOpen(false);
                            if (n.entity_type === 'response') navigate(`/responses/${n.entity_id}`);
                            else if (n.entity_type === 'survey') navigate(`/surveys/${n.entity_id}/builder`);
                            else if (n.entity_type === 'report') navigate(`/reports/${n.entity_id}`);
                          }}
                          className={`block w-full px-3 py-2.5 text-left hover:bg-canvas ${
                            !n.is_read ? 'bg-teal-tint/20' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <StatusBadge status={n.level} label={n.action} />
                            <span className="text-[10.5px] text-navy-400 tabular-nums whitespace-nowrap">
                              {formatRelativeTime(n.created_at)}
                            </span>
                          </div>
                          <p className="mt-1 text-[12px] text-navy-700 leading-snug">{n.summary}</p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Profile Menu */}
            <div className="relative" ref={profileContainerRef}>
              <button
                type="button"
                onClick={() => {
                  setProfileOpen((v) => !v);
                  setNotifOpen(false);
                }}
                aria-expanded={profileOpen}
                aria-haspopup="menu"
                className="flex shrink-0 items-center gap-2 rounded-sm border border-hairline px-2 py-1 text-left whitespace-nowrap hover:bg-canvas"
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-navy text-[11px] font-semibold text-white">
                  {user?.full_name
                    ?.split(' ')
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join('') || 'U'}
                </div>
                <div className="hidden sm:block">
                  <div className="text-[12px] font-medium leading-none text-navy">{user?.full_name}</div>
                  <div className="mt-0.5 text-[10.5px] leading-none text-navy-500">
                    {humanizeKey(user?.role || '')}
                  </div>
                </div>
              </button>

              {profileOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1.5 w-60 rounded border border-hairlineStrong bg-surface py-1 shadow-popover"
                >
                  <div className="border-b border-hairline px-3 py-2">
                    <div className="text-[12.5px] font-semibold text-navy">{user?.full_name}</div>
                    <div className="text-[11.5px] text-navy-500">{user?.email}</div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <StatusBadge status="active" label={humanizeKey(user?.role || '')} />
                      <span className="text-[11px] text-navy-400">{user?.region}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      navigate('/field');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-navy-700 hover:bg-canvas"
                  >
                    <Smartphone className="h-3.5 w-3.5 text-teal-accent" />
                    Open Mobile Field App
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProfileOpen(false);
                      logout();
                      navigate('/login');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-crimson-err hover:bg-crimson-tint/30"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Workspace Canvas */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>

      {/* Global Search Palette */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-navy/40 p-4 pt-16 sm:pt-20"
          role="dialog"
          aria-modal="true"
          aria-label="Global search"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-xl rounded border border-hairlineStrong bg-surface shadow-popover"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-hairline px-3.5 py-2.5">
              <Search className="h-4 w-4 text-navy-400" />
              <input
                ref={searchInputRef}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search surveys by code or title, submission IDs, districts, quality issues, or reports..."
                className="w-full bg-transparent text-[13px] text-navy outline-none placeholder:text-navy-400"
              />
              <kbd className="rounded border border-hairline bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-navy-400">
                ESC
              </kbd>
            </div>
            <div className="max-h-96 overflow-y-auto p-2">
              {searchTerm.trim().length < 2 ? (
                <div className="px-3 py-6 text-center text-[12px] text-navy-500">
                  Type at least 2 characters to search across the SurveyOps platform.
                </div>
              ) : !searchData ? (
                <div className="px-3 py-6 text-center text-[12px] text-navy-500">Searching...</div>
              ) : (
                <div className="space-y-3">
                  {searchData.surveys.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400">
                        Surveys
                      </div>
                      {searchData.surveys.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => {
                            setSearchOpen(false);
                            navigate(`/surveys/${s.id}/builder`);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] hover:bg-canvas"
                        >
                          <span className="truncate">
                            <span className="mr-2 font-mono text-[11.5px] text-teal-accent">{s.code}</span>
                            {s.title}
                          </span>
                          <StatusBadge status={s.status} />
                        </button>
                      ))}
                    </div>
                  )}
                  {searchData.responses.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400">
                        Responses
                      </div>
                      {searchData.responses.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => {
                            setSearchOpen(false);
                            navigate(`/responses/${r.id}`);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] hover:bg-canvas"
                        >
                          <span className="truncate">
                            <span className="mr-2 font-mono text-[11.5px] text-navy-600">{r.client_submission_id}</span>
                            <span className="text-navy-500">{r.district}</span>
                          </span>
                          <StatusBadge status={r.status} />
                        </button>
                      ))}
                    </div>
                  )}
                  {searchData.quality_issues.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400">
                        Quality Issues
                      </div>
                      {searchData.quality_issues.map((qi) => (
                        <button
                          key={qi.id}
                          type="button"
                          onClick={() => {
                            setSearchOpen(false);
                            navigate(`/responses/${qi.response_id}`);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12px] hover:bg-canvas"
                        >
                          <span className="truncate text-navy-700">{qi.message}</span>
                          <StatusBadge status={qi.severity} label={qi.issue_type} />
                        </button>
                      ))}
                    </div>
                  )}
                  {searchData.reports.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-navy-400">
                        Insight Reports
                      </div>
                      {searchData.reports.map((rep) => (
                        <button
                          key={rep.id}
                          type="button"
                          onClick={() => {
                            setSearchOpen(false);
                            navigate(`/reports/${rep.id}`);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[12.5px] hover:bg-canvas"
                        >
                          <span className="truncate">{rep.title}</span>
                          <UserIcon className="h-3.5 w-3.5 shrink-0 text-navy-400" />
                        </button>
                      ))}
                    </div>
                  )}
                  {searchData.surveys.length === 0 &&
                    searchData.responses.length === 0 &&
                    searchData.quality_issues.length === 0 &&
                    searchData.reports.length === 0 && (
                      <div className="px-3 py-6 text-center text-[12px] text-navy-500">
                        No matching records for &ldquo;{searchTerm}&rdquo;.
                      </div>
                    )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { user } = useAuth();
  return (
    <LiveEventsProvider enabled={Boolean(user)}>
      <AppShellInner />
    </LiveEventsProvider>
  );
}
