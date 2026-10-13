import { readFileSync } from 'node:fs';

const SECRET_KEYS = [
  'CENTRIFUGO_API_KEY',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const;

/**
 * Поддержка Docker/Swarm secrets: если задана `<KEY>_FILE`, значение
 * читается из этого файла. Явная переменная `<KEY>` имеет приоритет
 * (ConfigService сначала смотрит в process.env), поэтому локальная
 * разработка с `.env` работает как раньше.
 */
export function secretsConfig(): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key of SECRET_KEYS) {
    const filePath = process.env[`${key}_FILE`];

    if (filePath) {
      result[key] = readFileSync(filePath, 'utf8').trim();
    }
  }

  return result;
}
