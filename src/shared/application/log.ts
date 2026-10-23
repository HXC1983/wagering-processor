export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogFn = (level: LogLevel, message: string, fields?: LogFields) => void;
