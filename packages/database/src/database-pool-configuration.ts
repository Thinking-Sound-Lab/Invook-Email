interface DatabasePoolConfiguration {
  queryPoolSize: number;
  controlPoolSize: number;
}

function parsePoolSize(value: string | undefined, name: string, defaultSize: number): number {
  if (value === undefined) return defaultSize;
  const normalizedValue = value.trim();
  const size = Number(normalizedValue);
  if (!/^[1-9][0-9]*$/.test(normalizedValue) || !Number.isSafeInteger(size)) {
    throw new Error(name + " must be a positive integer.");
  }
  return size;
}

export function getDatabasePoolConfiguration(environment: NodeJS.ProcessEnv): DatabasePoolConfiguration {
  return {
    queryPoolSize: parsePoolSize(environment.DATABASE_POOL_SIZE, "DATABASE_POOL_SIZE", 3),
    controlPoolSize: parsePoolSize(environment.DATABASE_CONTROL_POOL_SIZE, "DATABASE_CONTROL_POOL_SIZE", 2),
  };
}
