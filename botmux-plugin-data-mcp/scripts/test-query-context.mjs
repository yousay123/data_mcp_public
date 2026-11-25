import assert from 'node:assert/strict';
import { renderQueryContext } from '../src/result-agent/query-context.js';

const context = {
  datasource: 'tchouse-c', tables: ['synthetic.events'],
  metric_expressions: ['calendar.date AS date', 'ifNull(daily.n, 0) AS total'],
  query_semantics: {
    source_blocks: [{ tables: ['synthetic.events'], filters: [
      { column: 'reg_time', operator: 'gte', value: '2026-11-15 00:00:00', is_time: true },
      { column: 'reg_time', operator: 'lt', value: '2026-11-24 00:00:00', is_time: true },
    ], time_groupings: [{ column: 'reg_time', grain: 'day' }],
    aggregations: [{ column: 'merchant_id', operation: 'count_distinct' }] }],
    unmatched_records_zero_filled: true, filter_coverage_complete: true,
  },
};
const paragraph = renderQueryContext(context).join('\n');
assert(paragraph.includes('2026-11-15 至 2026-11-23'));
assert(paragraph.includes('reg_time') && paragraph.includes('merchant_id'));
assert(paragraph.includes('去重计数') && paragraph.includes('0 补齐'));
assert(!paragraph.includes('calendar.date') && !paragraph.includes('ifNull') && !paragraph.includes(' AS '));
assert.equal((paragraph.match(/reg_time/gu) || []).length, 1);
assert(!paragraph.includes('##'));

const legacy = renderQueryContext({ ...context, query_semantics: undefined }).join('\n');
assert(legacy.includes('未完整提供'));
assert(!legacy.includes('ifNull') && !legacy.includes('merchant_id'));
const partial = renderQueryContext({ ...context, query_semantics: {
  ...context.query_semantics, filter_coverage_complete: false,
} }).join('\n');
assert(!partial.includes('未额外设置其他筛选条件'));
const scoped = renderQueryContext({ ...context, query_semantics: {
  ...context.query_semantics, source_blocks: [
    { tables: ['synthetic.a'], filters: [{ column: 'status', operator: 'eq', value: 'ok' }] },
    { tables: ['synthetic.b'], filters: [{ column: 'status', operator: 'eq', value: 'pending' }] },
  ],
} }).join('\n');
assert(scoped.includes('synthetic.a：') && scoped.includes('synthetic.b：'));
assert(!scoped.includes(' AND '));
console.log('natural query scope tests passed');
