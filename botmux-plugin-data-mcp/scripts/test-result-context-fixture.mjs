import { createHash } from 'node:crypto';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalContext(columns, overrides = {}) {
  const context = {
    schema_version: 1,
    provenance: 'data_mcp_validated_query_plan',
    datasource: 'tchouse-c',
    tables: ['synthetic.events'],
    metric_columns: columns.map(column => typeof column === 'string' ? column : column.name),
    metric_expressions: columns.map(column => typeof column === 'string' ? column : column.name),
    filter_predicates: [],
    time_range_predicates: [],
    grouping_columns: [],
    unit: { status: 'not_inferred_from_sql' },
    timezone: { status: 'database_session_default' },
    returned_columns: columns.map(column => typeof column === 'string'
      ? { name: column, type: '' }
      : { name: column.name, type: column.type ?? '' }),
    ...overrides,
  };
  context.integrity = {
    algorithm: 'sha256',
    digest: createHash('sha256').update(stableJson(context)).digest('hex'),
  };
  return context;
}
