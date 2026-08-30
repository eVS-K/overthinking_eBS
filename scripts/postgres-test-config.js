'use strict';

// A destructive integration test needs several independent opt-ins. Keep the
// parser separate from the test body so the refusal rules themselves receive
// ordinary unit-test coverage and never depend on a live database.
function databaseEndpointIdentity(connectionString, environment = process.env, { rejectEndpointOverrides = false } = {}) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('PostgreSQL connection URL is not valid.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('PostgreSQL connection URL must use the PostgreSQL protocol.');
  }
  // node-postgres accepts query-string host/port values in preference to the
  // URL authority. Parse that effective endpoint when comparing URLs; test
  // URLs themselves reject the override so the local-host requirement cannot
  // be bypassed by hiding a remote target in the query string.
  const endpointOverride = [...parsed.searchParams.keys()].find((key) => (
    ['host', 'hostaddr', 'port'].includes(key.toLowerCase())
  ));
  if (rejectEndpointOverrides && endpointOverride) {
    throw new Error(`PostgreSQL test URL may not override its endpoint with ?${endpointOverride}=.`);
  }
  const host = parsed.searchParams.get('host') || parsed.hostname;
  if (!host) throw new Error('PostgreSQL connection URL must include an explicit host.');
  const port = parsed.searchParams.get('port') || parsed.port || environment.PGPORT || '5432';
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!databaseName) throw new Error('PostgreSQL connection URL must include a database name.');
  return {
    // WHATWG URL keeps brackets around IPv6 hostnames. Normalise them so the
    // local `::1` allow-list and endpoint comparison use the same identity.
    host: host.toLowerCase().replace(/^\[([^\]]+)\]$/, '$1'),
    port: String(port),
    databaseName
  };
}

function readTestDatabaseUrl(environment = process.env) {
  if (environment.RUN_POSTGRES_INTEGRATION !== '1') {
    throw new Error('Refusing PostgreSQL integration tests: set RUN_POSTGRES_INTEGRATION=1 for a disposable test database.');
  }
  const connectionString = environment.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error('Refusing PostgreSQL integration tests: TEST_DATABASE_URL is required (DATABASE_URL is never used).');
  }
  let endpoint;
  try {
    endpoint = databaseEndpointIdentity(connectionString, environment, { rejectEndpointOverrides: true });
  } catch (error) {
    throw new Error(`Refusing PostgreSQL integration tests: ${error.message}`);
  }

  const { host, databaseName } = endpoint;
  if (!/(?:^|[_-])(?:test|testing)(?:[_-]|$)/i.test(databaseName)) {
    throw new Error('Refusing PostgreSQL integration tests: the database name must visibly contain test or testing.');
  }
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!localHost && environment.ALLOW_REMOTE_TEST_DATABASE !== '1') {
    throw new Error('Refusing PostgreSQL integration tests: a non-local test database additionally requires ALLOW_REMOTE_TEST_DATABASE=1.');
  }
  if (environment.DATABASE_URL) {
    let productionEndpoint;
    try {
      productionEndpoint = databaseEndpointIdentity(environment.DATABASE_URL, environment);
    } catch (error) {
      throw new Error(`Refusing PostgreSQL integration tests: DATABASE_URL cannot be safely compared (${error.message}).`);
    }
    if (endpoint.host === productionEndpoint.host
      && endpoint.port === productionEndpoint.port
      && endpoint.databaseName === productionEndpoint.databaseName) {
      throw new Error('Refusing PostgreSQL integration tests: TEST_DATABASE_URL resolves to the same database endpoint as DATABASE_URL.');
    }
  }
  return connectionString;
}

module.exports = { databaseEndpointIdentity, readTestDatabaseUrl };
