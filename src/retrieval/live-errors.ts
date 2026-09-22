import { LiveConfigError } from './live-config.js';
export function safeLiveError(error: unknown): string {
  if (error instanceof LiveConfigError) return error.message;
  if (error instanceof Error && ['COLLECTION_ALLOWANCE_EXCEEDED','RSS_SOURCE_NOT_ENABLED','LIVE_PROVIDER_INVALID','LIVE_OPT_IN_REQUIRED'].includes(error.message)) return error.message;
  return 'LOCAL_SETUP_OR_DATABASE_ERROR: inspect local database availability and migration status; no automatic retry was made';
}
