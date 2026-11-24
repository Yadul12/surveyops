import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { AppShell } from '@/components/layout/AppShell';
import { LoadingState, ToastProvider } from '@/components/ui/Primitives';
import { LoginPage } from '@/pages/auth/LoginPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { SurveysListPage } from '@/pages/surveys/SurveysListPage';
import { SurveyBuilderPage } from '@/pages/surveys/SurveyBuilderPage';
import { FieldAppPage } from '@/pages/field/FieldAppPage';
import { PipelinePage } from '@/pages/pipeline/PipelinePage';
import { ResponsesListPage } from '@/pages/pipeline/ResponsesListPage';
import { ResponseDetailPage } from '@/pages/quality/ResponseDetailPage';
import { QualityConsolePage } from '@/pages/quality/QualityConsolePage';
import { AnalyticsPage } from '@/pages/analytics/AnalyticsPage';
import { ReportsPage } from '@/pages/reports/ReportsPage';
import { ReportDetailPage } from '@/pages/reports/ReportDetailPage';
import { ScalabilityPage } from '@/pages/scalability/ScalabilityPage';
import type { UserRole } from '@/types';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({
  children,
  roles,
}: {
  children: React.ReactNode;
  roles?: UserRole[];
}) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <LoadingState message="Verifying authenticated session..." />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return <Navigate to={user.role === 'field_agent' ? '/field' : '/'} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />

              {/* Dedicated Mobile-First Field Agent Application */}
              <Route
                path="/field"
                element={
                  <ProtectedRoute>
                    <FieldAppPage />
                  </ProtectedRoute>
                }
              />

              {/* Enterprise Desktop Operations Shell */}
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <AppShell />
                  </ProtectedRoute>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path="surveys" element={<SurveysListPage />} />
                <Route path="surveys/:id" element={<Navigate to="builder" replace />} />
                <Route path="surveys/:id/builder" element={<SurveyBuilderPage />} />
                <Route path="pipeline" element={<PipelinePage />} />
                <Route path="responses" element={<ResponsesListPage />} />
                <Route path="responses/:id" element={<ResponseDetailPage />} />
                <Route
                  path="quality"
                  element={
                    <ProtectedRoute roles={['admin', 'analyst']}>
                      <QualityConsolePage />
                    </ProtectedRoute>
                  }
                />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="reports/:id" element={<ReportDetailPage />} />
                <Route
                  path="scalability"
                  element={
                    <ProtectedRoute roles={['admin', 'analyst']}>
                      <ScalabilityPage />
                    </ProtectedRoute>
                  }
                />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
