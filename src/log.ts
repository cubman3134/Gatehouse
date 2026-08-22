export interface Logger {
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

const secrets = new Set<string>();

/**
 * Registers a value that must never appear in a log line. Every line already goes through
 * `redact`, so the seam is live even though increment 1 has nothing to put in it and this
 * function therefore has no caller yet — that is deliberate, not dead code. Increment 4
 * registers configured credential values here, and the redaction property test asserts none
 * of them ever reach a log line.
 */
export function registerSecret(value: string): void {
  if (value.trim()) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

function emit(level: 'info' | 'warn' | 'error', msg: string, meta?: object): void {
  const line = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
  // eslint-disable-next-line no-console
  console[level === 'info' ? 'log' : level](`gatehouse: ${redact(line)}`);
}

export const log: Logger = {
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};
