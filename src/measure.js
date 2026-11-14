import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';

export const REQUEST_COUNT = 10;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Результат одной полной загрузки. @typedef {{bytes: number, durationMs: number}} Sample */

/** @param {string | URL} input Адрес загружаемого ресурса. */
export function validateUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только адреса HTTP и HTTPS.');
  }
  return url;
}

/** @param {number} timeoutMs Предельная длительность одной загрузки. */
function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Тайм-аут должен быть целым числом от 1 до ${MAX_TIMEOUT_MS} мс.`);
  }
}

/**
 * @param {URL} url Адрес запроса.
 * @param {AbortSignal} signal Общий сигнал отмены для всей цепочки перенаправлений.
 * @returns {Promise<import('node:http').IncomingMessage>} Поток ответа.
 */
function getResponse(url, signal) {
  return new Promise((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, {
      signal,
      headers: {
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'User-Agent': 'download-speed-cli/1.0',
      },
    }, resolve);
    request.on('error', reject);
  });
}

/**
 * @param {string | URL} input Адрес ресурса.
 * @param {number} timeoutMs Тайм-аут, включая перенаправления и чтение тела.
 * @returns {Promise<Sample>} Объём тела и время полной загрузки.
 */
export async function download(input, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let url = validateUrl(input);
  validateTimeout(timeoutMs);
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await getResponse(url, controller.signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;

      if (REDIRECT_STATUSES.has(status) && location) {
        if (redirects >= MAX_REDIRECTS) {
          response.destroy();
          throw new Error(`Превышен лимит перенаправлений: ${MAX_REDIRECTS}.`);
        }
        // Дочитываем промежуточный ответ, но не включаем его тело в объём ресурса.
        response.resume();
        await finished(response, { cleanup: true });
        url = validateUrl(new URL(location, url));
        continue;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        throw new Error(`Сервер вернул HTTP ${status}.`);
      }

      let bytes = 0;
      // Потоковое чтение не требует держать весь файл в памяти.
      for await (const chunk of response) {
        bytes += chunk.length;
      }
      return { bytes, durationMs: performance.now() - started };
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Превышен тайм-аут загрузки: ${timeoutMs} мс.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Sample[]} samples Результаты завершённых загрузок. */
export function summarize(samples) {
  const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  const totalDurationMs = samples.reduce((sum, sample) => sum + sample.durationMs, 0);
  if (samples.length === 0 || totalDurationMs <= 0) {
    throw new Error('Для расчёта нужны загрузки с положительным суммарным временем.');
  }
  const bytesPerSecond = totalBytes / (totalDurationMs / 1000);
  return {
    requests: samples.length,
    totalBytes,
    totalDurationMs,
    averageDurationMs: totalDurationMs / samples.length,
    mebibytesPerSecond: bytesPerSecond / (1024 * 1024),
    megabitsPerSecond: bytesPerSecond * 8 / 1_000_000,
  };
}

/**
 * @param {string | URL} input Адрес ресурса.
 * @param {number} timeoutMs Тайм-аут каждой отдельной загрузки.
 */
export async function measure(input, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = validateUrl(input);
  validateTimeout(timeoutMs);
  /** @type {Sample[]} Результаты только полностью завершённых запросов. */
  const samples = [];
  for (let index = 0; index < REQUEST_COUNT; index += 1) {
    try {
      // Следующий запрос начинается только после полного чтения предыдущего.
      samples.push(await download(url, timeoutMs));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Запрос ${index + 1}/${REQUEST_COUNT}: ${message}`, { cause: error });
    }
  }
  return summarize(samples);
}
