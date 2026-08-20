// server.js — wiring do Express, boot e shutdown. A lógica vive em src/.
import express from 'express';
import {
  API_TOKEN,
  CORS_ALLOW_ANY,
  CORS_ORIGINS,
  JSON_BODY_LIMIT,
  MAX_RETRIES,
  MODEL_IDLE_TIMEOUT_MS,
  PORT,
} from './src/config.js';
import {
  corsMiddleware,
  errorHandler,
  rateLimiter,
  requestLogger,
  requireToken,
} from './src/lib/middleware.js';
import { createRouter } from './src/routes.js';
import { missingProviders } from './src/models.js';
import { closeDb } from './src/db.js';
import { C, log } from './src/logger.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(corsMiddleware());
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(requestLogger);
app.use(rateLimiter());
app.use(requireToken);
app.use(createRouter());
app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`\n${C.bold}many-ais${C.reset} rodando em ${C.cyan}http://localhost:${PORT}${C.reset}`);
  console.log(
    `${C.dim}idle timeout por modelo: ${MODEL_IDLE_TIMEOUT_MS}ms · retries: ${MAX_RETRIES}${C.reset}`
  );

  const missing = missingProviders();
  if (missing.length > 0) {
    log(
      C.yellow,
      '⚠',
      `providers sem API key (modelos desativados): ${missing
        .map((p) => `${p.provider} (${p.envKey})`)
        .join(', ')}`
    );
  }
  if (!API_TOKEN) {
    log(C.yellow, '⚠', 'API_TOKEN não definido — a API está aberta. Ok em localhost, não em rede.');
  }
  log(
    C.gray,
    'ℹ',
    CORS_ALLOW_ANY ? 'CORS liberado para qualquer origem' : `CORS: ${CORS_ORIGINS.join(', ')}`
  );

  console.log(`${C.dim}endpoints:${C.reset}`);
  for (const line of [
    'GET    /health',
    'GET    /models',
    'GET    /conversations',
    'GET    /conversations/:id',
    'DELETE /conversations/:id',
    'POST   /chat/stream  (SSE)',
  ]) {
    console.log(`${C.dim}  ${line}${C.reset}`);
  }
  console.log('');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(C.yellow, '⏻', `${signal} recebido, encerrando...`);

  // Streams SSE em voo podem demorar; depois de 10s desiste e força a saída.
  const force = setTimeout(() => {
    log(C.red, '✗', 'shutdown demorou demais, forçando saída');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close(() => {
    closeDb();
    clearTimeout(force);
    log(C.green, '✓', 'encerrado');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log(C.red, '✗', `unhandledRejection: ${reason?.message || reason}`);
});
