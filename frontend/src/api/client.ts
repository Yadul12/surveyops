const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

export const TOKEN_STORAGE_KEY = 'surveyops_jwt_token';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | null | undefined>): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const base = `${API_BASE}${cleanPath}`;
  if (!params) return base;
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      searchParams.set(k, String(v));
    }
  });
  const qs = searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number | boolean | null | undefined>;
  } = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(path, options.params), {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const errJson = await res.json();
      if (typeof errJson.detail === 'string') {
        detail = errJson.detail;
      } else if (Array.isArray(errJson.detail)) {
        detail = errJson.detail.map((d: { msg?: string; loc?: string[] }) => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ');
      }
    } catch {
      // ignore parse errors
    }
    if (res.status === 401 && !path.includes('/auth/login')) {
      setStoredToken(null);
      window.dispatchEvent(new CustomEvent('surveyops:unauthorized'));
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) {
    return {} as T;
  }
  return res.json() as Promise<T>;
}

export async function apiDownloadFile(
  path: string,
  fallbackFilename: string,
  params?: Record<string, string | number | boolean | null | undefined>
): Promise<void> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(buildUrl(path, params), { headers });
  if (!res.ok) {
    throw new ApiError(res.status, `Download failed (${res.status})`);
  }

  const blob = await res.blob();
  const disp = res.headers.get('Content-Disposition') || '';
  const match = disp.match(/filename="?([^"]+)"?/i);
  const filename = match ? match[1] : fallbackFilename;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function getSseStreamUrl(): string | null {
  const token = getStoredToken();
  if (!token) return null;
  return buildUrl('/events/stream', { token });
}
