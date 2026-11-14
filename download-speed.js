#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MAX_TIMEOUT_MS, measure } from './src/measure.js';

const HELP = `Замер скорости скачивания: 10 последовательных HTTP(S)-загрузок.

Запуск: node download-speed.js <URL> [--timeout <секунды>]

  -t, --timeout   Тайм-аут одной полной загрузки (по умолчанию 30 с).
  -h, --help      Показать справку.

Пример: node download-speed.js "https://example.com/large-image.jpg" --timeout 60
Единицы скорости: MiB/s (1 MiB = 1 048 576 байт) и Mbit/s (1 Mbit = 1 000 000 бит).`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h', default: false },
      timeout: { type: 'string', short: 't', default: '30' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const [url] = positionals;
  if (!url || positionals.length !== 1) {
    throw new Error('Укажите один HTTP(S)-адрес. Справка: node download-speed.js --help');
  }
  const timeoutMs = Number(values.timeout) * 1000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('Тайм-аут должен быть положительным числом секунд с точностью до 1 мс (не более 2147483.647).');
  }

  const result = await measure(url, timeoutMs);
  console.log(`Завершено запросов: ${result.requests}`);
  console.log(`Среднее время запроса: ${result.averageDurationMs.toFixed(2)} мс`);
  console.log(`Общий объём: ${result.totalBytes} байт (${(result.totalBytes / 1024 ** 2).toFixed(3)} MiB)`);
  console.log(`Суммарное время загрузок: ${(result.totalDurationMs / 1000).toFixed(3)} с`);
  console.log(`Скорость скачивания: ${result.mebibytesPerSecond.toFixed(3)} MiB/s (${result.megabitsPerSecond.toFixed(3)} Mbit/s)`);
}

main().catch((error) => {
  console.error(`Ошибка: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
