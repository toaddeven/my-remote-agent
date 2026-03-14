export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env['LOG_LEVEL'] as LogLevel) ?? 'info';

function log(level: LogLevel, module: string, message: string, args: unknown[]): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`;
  const extra = args.length > 0 ? ' ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') : '';

  const line = `${prefix} ${message}${extra}`;

  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export function createLogger(module: string): Logger {
  return {
    debug(message: string, ...args: unknown[]): void {
      log('debug', module, message, args);
    },
    info(message: string, ...args: unknown[]): void {
      log('info', module, message, args);
    },
    warn(message: string, ...args: unknown[]): void {
      log('warn', module, message, args);
    },
    error(message: string, ...args: unknown[]): void {
      log('error', module, message, args);
    },
  };
}
