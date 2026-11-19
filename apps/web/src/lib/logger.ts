/**
 * Server-side logger for apps/web.
 * Uses @chronos/logger in redact mode — health data never reaches logs.
 * Never import this in Client Components (it uses Node.js APIs).
 */
import { createLogger } from '@chronos/logger';
import { config } from './config';

export const logger = createLogger({
  service: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  mode: 'redact',
});
