// middleware.js — CORS com allowlist, auth por token e rate limit em memória.
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import {
  API_TOKEN,
  CORS_ALLOW_ANY,
  CORS_ORIGINS,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '../config.js';
import { C, log } from '../logger.js';

export function corsMiddleware() {
  if (CORS_ALLOW_ANY) return cors();
  return cors({
    origin(origin, callback) {
      // Sem Origin = curl / mesma origem / app nativo: não é um risco de CSRF.
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`Origin não permitida: ${origin}`));
    },
    credentials: false,
  });
}

function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Auth opcional por segredo compartilhado. Sem API_TOKEN definido a API fica
 * aberta — aceitável em localhost, nunca em rede. O boot avisa quando é o caso.
 */
export function requireToken(req, res, next) {
  if (!API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const provided = bearer || (req.get('x-api-token') || '').trim();
  if (provided && safeCompare(provided, API_TOKEN)) return next();
  res.status(401).json({ error: 'não autorizado' });
}

/**
 * Rate limit por IP em janela fixa, em memória. Suficiente para um processo só;
 * atrás de várias instâncias, trocar por Redis.
 */
export function rateLimiter({ max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS, name = 'geral' } = {}) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return function limiter(req, res, next) {
    if (max <= 0) return next();
    const key = req.ip || req.socket.remoteAddress || 'desconhecido';
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      log(C.yellow, '⚠', `rate limit (${name}) atingido por ${key}`);
      return res.status(429).json({ error: 'muitas requisições, tente de novo em instantes' });
    }
    next();
  };
}

export function requestLogger(req, _res, next) {
  log(C.gray, '→', `${C.bold}${req.method}${C.reset} ${req.path}`);
  next();
}

/** Handler de erro final — inclusive o rejeito de CORS, que vira 403 e não 500. */
export function errorHandler(err, _req, res, _next) {
  if (err?.message?.startsWith('Origin não permitida')) {
    return res.status(403).json({ error: err.message });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'corpo da requisição grande demais' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  log(C.red, '✗', `erro não tratado: ${err?.message || err}`);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'erro interno' });
}
