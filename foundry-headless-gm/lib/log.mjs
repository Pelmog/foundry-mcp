export function createLogger(password = '', write = line => process.stdout.write(line + '\n')) {
  const redact = value => typeof value === 'string' && password
    ? value.split(password).join('[REDACTED]') : value;
  return (event, fields = {}) => write(JSON.stringify(
    { ...fields, time: new Date().toISOString(), event }, (_key, value) => redact(value)
  ));
}

export function errorMessage(error, password = '') {
  const message = String(error?.message ?? error);
  return password ? message.split(password).join('[REDACTED]') : message;
}
