// sse.js — canal Server-Sent Events com heartbeat e detecção de desconexão.
import { SSE_HEARTBEAT_MS } from '../config.js';

/**
 * Abre o canal SSE sobre uma resposta do Express.
 *
 * - `send(event, data)` vira no-op depois que o cliente sai ou a resposta fecha,
 *   então nenhum caller precisa checar antes de escrever.
 * - Um comentário `: ping` periódico evita que proxies/load balancers derrubem
 *   a conexão nas fases silenciosas (entre o fim da R1 e o primeiro delta da R2).
 */
export function openSSE(res, { onClose } = {}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    try {
      res.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref?.();

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
  };

  res.on('close', () => {
    const wasOpen = !closed && !res.writableEnded;
    stop();
    if (wasOpen) onClose?.();
  });

  return {
    get closed() {
      return closed || res.writableEnded;
    },
    send(event, data) {
      if (this.closed) return false;
      try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        stop();
        return false;
      }
    },
    end() {
      clearInterval(heartbeat);
      if (res.writableEnded) return;
      closed = true;
      try {
        res.end();
      } catch {
        /* socket já morreu */
      }
    },
  };
}
