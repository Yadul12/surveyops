import type { SurveyAssignmentItem } from '@/types';

const DB_NAME = 'surveyops_field_v1';
const DB_VERSION = 1;

export type SyncStatus = 'local_saved' | 'syncing' | 'synced' | 'failed';

export interface OfflineDraftRecord {
  assignment_id: string;
  survey_id: string;
  survey_title: string;
  district: string;
  consent_given: boolean;
  location_consent_given: boolean;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  respondent_ref: string;
  respondent_ward: string;
  respondent_age_bracket: string;
  answers: Record<string, unknown>;
  started_at: string;
  updated_at: string;
}

export interface OfflineQueuedSubmission {
  client_submission_id: string;
  assignment_id: string;
  survey_id: string;
  survey_version_id: string;
  survey_code: string;
  survey_title: string;
  district: string;
  consent_given: boolean;
  location_consent_given: boolean;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  respondent: {
    external_ref: string;
    district: string;
    ward: string;
    age_bracket: string | null;
  };
  answers: Record<string, unknown>;
  started_at: string;
  submitted_at: string;
  duration_seconds: number;
  source_channel: 'mobile_offline' | 'mobile_online';
  sync_status: SyncStatus;
  attempt_count: number;
  last_error: string | null;
  server_response_id: string | null;
  server_processing_status: string | null;
  synced_at: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cached_assignments')) {
        db.createObjectStore('cached_assignments', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'assignment_id' });
      }
      if (!db.objectStoreNames.contains('submission_queue')) {
        const store = db.createObjectStore('submission_queue', { keyPath: 'client_submission_id' });
        store.createIndex('sync_status', 'sync_status', { unique: false });
        store.createIndex('submitted_at', 'submitted_at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function runTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = operation(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function cacheAssignmentsOffline(assignments: SurveyAssignmentItem[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cached_assignments', 'readwrite');
    const store = tx.objectStore('cached_assignments');
    store.clear();
    assignments.forEach((a) => store.put(a));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function getCachedAssignmentsOffline(): Promise<SurveyAssignmentItem[]> {
  return runTx<SurveyAssignmentItem[]>('cached_assignments', 'readonly', (s) => s.getAll());
}

export async function saveFieldDraft(draft: OfflineDraftRecord): Promise<void> {
  await runTx('drafts', 'readwrite', (s) => s.put(draft));
}

export async function getFieldDraft(assignmentId: string): Promise<OfflineDraftRecord | undefined> {
  return runTx<OfflineDraftRecord | undefined>('drafts', 'readonly', (s) => s.get(assignmentId));
}

export async function listFieldDrafts(): Promise<OfflineDraftRecord[]> {
  return runTx<OfflineDraftRecord[]>('drafts', 'readonly', (s) => s.getAll());
}

export async function deleteFieldDraft(assignmentId: string): Promise<void> {
  await runTx('drafts', 'readwrite', (s) => s.delete(assignmentId));
}

export async function putQueuedSubmission(item: OfflineQueuedSubmission): Promise<void> {
  await runTx('submission_queue', 'readwrite', (s) => s.put(item));
}

export async function listQueuedSubmissions(): Promise<OfflineQueuedSubmission[]> {
  const rows = await runTx<OfflineQueuedSubmission[]>('submission_queue', 'readonly', (s) => s.getAll());
  return rows.sort((a, b) => new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime());
}

export async function deleteQueuedSubmission(clientSubmissionId: string): Promise<void> {
  await runTx('submission_queue', 'readwrite', (s) => s.delete(clientSubmissionId));
}
