import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

export const providerEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
    command: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
    maxTurns: z.number().int().positive().optional(),
    headers: z.record(z.string()).optional(),
  })
  .passthrough();

export const providersConfigSchema = z.object({
  defaultProvider: z.string().optional(),
  providers: z.array(providerEntrySchema).min(1),
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export async function loadProvidersConfig(configPath: string): Promise<ProvidersConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read providers config at ${configPath}: ${message}`);
  }

  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid YAML in ${configPath}: ${message}`);
  }

  const interpolated = interpolateEnv(doc, configPath, '');
  const result = providersConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ');
    throw new Error(`Invalid providers config ${configPath}: ${issues}`);
  }
  return result.data;
}

function interpolateEnv(value: unknown, source: string, keyPath: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        throw new Error(
          `Environment variable "${name}" referenced at "${keyPath || '<root>'}" in ${source} is not set`,
        );
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, source, `${keyPath}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, source, keyPath ? `${keyPath}.${key}` : key)]),
    );
  }
  return value;
}
