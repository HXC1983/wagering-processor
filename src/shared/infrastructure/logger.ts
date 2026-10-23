import type { LogFn } from '../application/log';

/** Log estruturado em JSON. Nunca inclua payloads financeiros nos campos. */
export const jsonLog: LogFn = (level, message, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
};
