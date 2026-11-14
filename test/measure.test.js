import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { download, measure, summarize, validateUrl } from '../src/measure.js';

/**
 * @param {import('node:test').TestContext} t Контекст теста.
 * @param {import('node:http').RequestListener} handler Обработчик локального сервера.
 */
async function serve(t, handler) {
  const server = createServer(handler);
  t.after(async () => {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * @param {string[]} args Аргументы консольного скрипта.
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>} Результат запуска.
 */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../download-speed.js', import.meta.url)), ...args,
    ], { timeout: 5000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
  });
}

test('формулы: среднее время, общий объём и взвешенная скорость', () => {
  const result = summarize([
    { bytes: 1024 ** 2, durationMs: 250 },
    { bytes: 3 * 1024 ** 2, durationMs: 750 },
  ]);
  assert.deepEqual(result, {
    requests: 2,
    totalBytes: 4 * 1024 ** 2,
    totalDurationMs: 1000,
    averageDurationMs: 500,
    mebibytesPerSecond: 4,
    megabitsPerSecond: 33.554432,
  });
  assert.throws(() => summarize([]), /положительным/);
  assert.throws(() => summarize([{ bytes: 1, durationMs: 0 }]), /положительным/);
});

test('адрес: допускаются только корректные HTTP(S) URL', () => {
  assert.equal(validateUrl('http://localhost/a').protocol, 'http:');
  assert.equal(validateUrl('https://example.com/a').protocol, 'https:');
  for (const input of ['ftp://example.com/a', 'file:///a', 'not-a-url']) {
    assert.throws(() => validateUrl(input));
  }
});

test('ровно 10 запросов: последовательно, до конца тела, с подсчётом байтов', async (t) => {
  const first = Buffer.from('Начало ответа: ');
  const last = Buffer.alloc(65_537, 42);
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const url = await serve(t, (request, response) => {
    requests += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.equal(request.headers['cache-control'], 'no-cache');
    response.on('finish', () => { active -= 1; });
    response.write(first);
    setTimeout(() => response.end(last), 5);
  });
  const result = await measure(url);
  assert.equal(requests, 10);
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  assert.equal(result.requests, 10);
  assert.equal(result.totalBytes, (first.length + last.length) * 10);
  assert.ok(result.totalDurationMs > 0);
  assert.equal(result.averageDurationMs, result.totalDurationMs / 10);
  assert.ok(Number.isFinite(result.mebibytesPerSecond));
});

test('таймер включает ожидание последнего байта, а не только заголовков', async (t) => {
  const url = await serve(t, (_request, response) => {
    response.write('first');
    setTimeout(() => response.end('last'), 80);
  });
  const result = await download(url);
  assert.equal(result.bytes, 9);
  assert.ok(result.durationMs >= 60);
});

test('пустые успешные ответы дают нулевой объём и скорость', async (t) => {
  const url = await serve(t, (_request, response) => {
    response.writeHead(204).end();
  });
  const result = await measure(url);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.mebibytesPerSecond, 0);
  assert.equal(result.megabitsPerSecond, 0);
});

test('подсчитываются фактические байты даже при сжатом ответе', async (t) => {
  const compressed = gzipSync(Buffer.alloc(10_000, 97));
  const url = await serve(t, (_request, response) => {
    response.writeHead(200, { 'Content-Encoding': 'gzip' }).end(compressed);
  });
  assert.equal((await download(url)).bytes, compressed.length);
});

test('относительные перенаправления: учитывается только тело конечного ответа', async (t) => {
  for (const status of [301, 302, 303, 307, 308]) {
    await t.test(`HTTP ${status}`, async (subtest) => {
      let requests = 0;
      const url = await serve(subtest, (request, response) => {
        requests += 1;
        if (request.url === '/start') {
          response.writeHead(status, { Location: '/end' }).end('redirect body');
        } else {
          response.end('final');
        }
      });
      assert.equal((await download(`${url}/start`)).bytes, 5);
      assert.equal(requests, 2);
    });
  }
});

test('циклические перенаправления ограничены пятью переходами', async (t) => {
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests += 1;
    response.writeHead(302, { Location: '/' }).end();
  });
  await assert.rejects(download(url), /лимит перенаправлений: 5/);
  assert.equal(requests, 6);
});

test('перенаправления без Location и на другой протокол отклоняются', async (t) => {
  const url = await serve(t, (request, response) => {
    response.writeHead(302, request.url === '/unsafe' ? { Location: 'file:///etc/passwd' } : {}).end();
  });
  await assert.rejects(download(url), /HTTP 302/);
  await assert.rejects(download(`${url}/unsafe`), /только адреса HTTP/);
});

test('HTTP-ошибка останавливает замер без повторов и частичной статистики', async (t) => {
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests += 1;
    response.writeHead(requests === 3 ? 503 : 200).end('body');
  });
  await assert.rejects(measure(url), /Запрос 3\/10: Сервер вернул HTTP 503/);
  assert.equal(requests, 3);
});

test('тайм-аут срабатывает до заголовков и при зависшем теле', async (t) => {
  const url = await serve(t, (request, response) => {
    if (request.url === '/body') {
      response.write('partial');
    }
  });
  await assert.rejects(download(url, 50), /тайм-аут/);
  await assert.rejects(download(`${url}/body`, 50), /тайм-аут/);
});

test('тайм-аут общий для всей цепочки перенаправлений', async (t) => {
  const url = await serve(t, (request, response) => {
    setTimeout(() => {
      if (request.url === '/end') {
        response.end('done');
      } else {
        response.writeHead(302, { Location: request.url === '/' ? '/next' : '/end' }).end();
      }
    }, 40);
  });
  await assert.rejects(download(url, 100), /тайм-аут/);
});

test('поступающие данные не сбрасывают общий тайм-аут', { timeout: 2000 }, async (t) => {
  const url = await serve(t, (_request, response) => {
    response.write('start');
    const timer = setInterval(() => response.write('more'), 5);
    response.on('close', () => clearInterval(timer));
  });
  await assert.rejects(download(url, 80), /тайм-аут/);
});

test('оборванное тело не считается успешной загрузкой', async (t) => {
  const url = await serve(t, (_request, response) => {
    response.writeHead(200, { 'Content-Length': 100, Connection: 'close' }).end('short');
  });
  await assert.rejects(download(url, 1000), /aborted|closed|reset/i);
});

test('ошибка соединения останавливает замер на первом запросе', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve) => { server.close(resolve); });
  await assert.rejects(
    measure(`http://127.0.0.1:${address.port}`, 1000),
    /Запрос 1\/10: connect ECONNREFUSED/,
  );
});

test('некорректные тайм-ауты отклоняются до запроса', async () => {
  for (const timeout of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(download('http://127.0.0.1', timeout), /Тайм-аут/);
    await assert.rejects(measure('http://127.0.0.1', timeout), /Тайм-аут/);
  }
});

test('CLI: выводит статистику и единицы измерения', async (t) => {
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests += 1;
    response.end('12345');
  });
  const result = await runCli([url, '--timeout', '2']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Завершено запросов: 10/);
  assert.match(result.stdout, /Среднее время запроса: [\d.]+ мс/);
  assert.match(result.stdout, /Общий объём: 50 байт/);
  assert.match(result.stdout, /Скорость скачивания: [\d.]+ MiB\/s \([\d.]+ Mbit\/s\)/);
  assert.equal(requests, 10);
});

test('CLI: справка доступна без URL', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Запуск:/);
});

test('CLI: при HTTP-ошибке нет частичной статистики', async (t) => {
  let requests = 0;
  const url = await serve(t, (_request, response) => {
    requests += 1;
    response.writeHead(404).end('not found');
  });
  const result = await runCli([url]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Запрос 1\/10: Сервер вернул HTTP 404/);
  assert.equal(requests, 1);
});

test('CLI: ошибки аргументов возвращают код 1 и сообщение в stderr', async (t) => {
  for (const args of [
    [], ['http://a', 'http://b'], ['file:///test'], ['not-a-url'],
    ['http://a', '--unknown'], ['http://a', '--timeout'],
    ...['0', '-1', 'NaN', 'Infinity', '2147484', '0.0001'].map(
      (value) => ['http://a', '--timeout', value],
    ),
  ]) {
    await t.test(JSON.stringify(args), async () => {
      const result = await runCli(args);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Ошибка:/);
    });
  }
});
