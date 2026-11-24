import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Activity, AlertCircle, Lock, ShieldCheck, Smartphone, UserCheck } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

const loginSchema = z.object({
  email: z.string().email('Enter a valid organizational email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

const DEMO_ACCOUNTS = [
  {
    label: 'Administrator',
    email: 'admin@surveyops.org',
    pass: 'AdminPass123!',
    desc: 'Survey builder, publishing, assignments, full governance',
    icon: ShieldCheck,
  },
  {
    label: 'Data Quality Analyst',
    email: 'analyst@surveyops.org',
    pass: 'AnalystPass123!',
    desc: 'Quality console, record corrections, analytics & PDF reports',
    icon: UserCheck,
  },
  {
    label: 'Field Enumerator',
    email: 'agent@surveyops.org',
    pass: 'AgentPass123!',
    desc: 'Mobile offline-first collection & IndexedDB sync queue',
    icon: Smartphone,
  },
];

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: 'admin@surveyops.org', password: 'AdminPass123!' },
  });

  const onSubmit = async (data: LoginFormValues) => {
    setServerError(null);
    try {
      const user = await login(data.email, data.password);
      navigate(user.role === 'field_agent' ? '/field' : '/');
    } catch (err: unknown) {
      setServerError(err instanceof Error ? err.message : 'Authentication failed');
    }
  };

  return (
    <div className="flex min-h-screen flex-col justify-center bg-canvas px-4 py-12">
      <div className="mx-auto w-full max-w-[440px]">
        {/* Brand Identity */}
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-navy text-white">
            <Activity className="h-4 w-4 text-teal-border" />
          </div>
          <div>
            <div className="text-[16px] font-semibold leading-none tracking-tight text-navy">SurveyOps</div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-wider text-navy-500">
              Enterprise Field Survey Intelligence Platform
            </div>
          </div>
        </div>

        {/* Auth Card */}
        <div className="ops-surface p-6">
          <h1 className="text-[16px] font-semibold text-navy">Sign in to workspace</h1>
          <p className="mt-1 text-[12.5px] text-navy-500">
            Authenticated JWT session with role-based access controls.
          </p>

          {serverError && (
            <div className="mt-4 flex items-start gap-2 rounded-sm border border-crimson-border bg-crimson-tint/60 p-2.5 text-[12px] text-crimson-err">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{serverError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit(onSubmit)} className="mt-4 space-y-3.5">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Work Email</label>
              <input
                type="email"
                {...register('email')}
                className="ops-input"
                placeholder="name@surveyops.org"
                autoComplete="email"
              />
              {errors.email && <p className="mt-1 text-[11.5px] text-crimson-err">{errors.email.message}</p>}
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Password</label>
              <input
                type="password"
                {...register('password')}
                className="ops-input"
                autoComplete="current-password"
              />
              {errors.password && <p className="mt-1 text-[11.5px] text-crimson-err">{errors.password.message}</p>}
            </div>

            <button type="submit" disabled={isSubmitting} className="ops-btn-primary w-full py-2">
              <Lock className="h-3.5 w-3.5" />
              {isSubmitting ? 'Authenticating...' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* Role Quick-Switch Directory */}
        <div className="mt-4 ops-surface p-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-navy-500">
            Seeded Role Credentials (Click to fill)
          </div>
          <div className="mt-2.5 space-y-1.5">
            {DEMO_ACCOUNTS.map((acc) => {
              const Icon = acc.icon;
              return (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => {
                    setValue('email', acc.email);
                    setValue('password', acc.pass);
                    setServerError(null);
                  }}
                  className="flex w-full items-start gap-2.5 rounded-sm border border-hairline bg-canvas/50 p-2.5 text-left transition-colors hover:border-teal-accent hover:bg-teal-tint/25"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-teal-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-semibold text-navy">{acc.label}</span>
                      <span className="font-mono text-[11px] text-navy-500">{acc.email}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-navy-500">{acc.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
