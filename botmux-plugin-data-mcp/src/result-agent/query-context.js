// Shared metadata-only presentation for result-agent and transport fallback paths.
function markdownTableCell(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

export function renderQueryContext(context) {
  if (!context || typeof context !== "object") return [];
  context = { ...context, tables: Array.isArray(context.tables) ? context.tables : [] };
  const parts = [`数据来自 ${String(context.datasource).toUpperCase()}${context.tables.length ? ` 的 ${context.tables.join('、')}` : ''}`];
  const semantics = context.query_semantics;
  if (!semantics || !Array.isArray(semantics.source_blocks)) {
    parts.push('查询计划未完整提供可解释的时间、去重及过滤信息，此处不作推断');
  } else {
    for (const block of semantics.source_blocks) {
      const clauses = [];
      const filters = Array.isArray(block.filters) ? block.filters : [];
      const byColumn = new Map();
      for (const filter of filters.filter(item => item.is_time)) {
        if (!byColumn.has(filter.column)) byColumn.set(filter.column, []);
        byColumn.get(filter.column).push(filter);
      }
      for (const [column, conditions] of byColumn) {
        const midnight = /^\d{4}-\d{2}-\d{2}(?:[ T]00:00:00(?:\.0+)?)?$/u;
        const start = conditions.find(item => item.operator === 'gte' && midnight.test(item.value));
        const end = conditions.find(item => item.operator === 'lt' && midnight.test(item.value));
        if (start && end && conditions.length === 2) {
          const lastDate = new Date(`${end.value.slice(0, 10)}T00:00:00Z`);
          lastDate.setUTCDate(lastDate.getUTCDate() - 1);
          clauses.push(`统计 ${start.value.slice(0, 10)} 至 ${lastDate.toISOString().slice(0, 10)}${(block.time_groupings || []).some(item => item.column === column) ? '' : `，以 ${column} 为时间依据`}`);
        } else {
          const labels = { gte: '不早于', gt: '晚于', lte: '不晚于', lt: '早于', eq: '为', neq: '不为' };
          for (const item of conditions) clauses.push(`${column}${labels[item.operator] || '按已确认条件限定为'} ${item.value}`);
        }
      }
      for (const item of block.time_groupings || []) clauses.push(`按 ${item.column} 对应的日期汇总`);
      const operations = { count_distinct: '去重计数', count: '计数', sum: '求和', avg: '计算平均值', min: '取最小值', max: '取最大值' };
      for (const item of block.aggregations || []) {
        if (operations[item.operation]) clauses.push(`对 ${item.column} ${operations[item.operation]}`);
      }
      const labels = { eq: '为', neq: '不为', gt: '大于', gte: '不小于', lt: '小于', lte: '不大于' };
      for (const item of filters.filter(item => !item.is_time && item.column)) {
        clauses.push(`仅保留 ${item.column}${labels[item.operator] || '符合'}“${item.value}”的记录`);
      }
      if (filters.some(item => item.status === 'not_simplified')) clauses.push('另有未能简写的复杂筛选条件，需结合查询计划核对');
      if (clauses.length) parts.push(`${semantics.source_blocks.length > 1 ? `${block.tables.join('、')}：` : ''}${[...new Set(clauses)].join('，')}`);
    }
    if (semantics.unmatched_records_zero_filled) parts.push('无匹配记录时以 0 补齐');
    const filters = semantics.source_blocks.flatMap(block => block.filters || []);
    if (semantics.filter_coverage_complete && filters.every(item => item.is_time)) parts.push('未额外设置其他筛选条件');
    else if (!semantics.filter_coverage_complete) parts.push('派生结果的部分筛选信息未完整展开，不据此认定没有其他过滤');
  }
  parts.push('使用数据库会话时区，具体时区未单独核验');
  return ['---', '', `**数据口径**：${parts.map(markdownTableCell).join('；')}。`];
}

