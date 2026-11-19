import { deflateRawSync } from 'node:zlib';

const MAX_SHEETS = 5;
const MAX_ROWS = 10_000;
const MAX_COLUMNS = 100;
const MAX_BYTES = 10 * 1024 * 1024;

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]);
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return `<v>${value}</v>`;
  if (typeof value === 'boolean') return `<v>${value ? 1 : 0}</v>`;
  if (typeof value !== 'string' || value.length > 32_767) throw new Error('result_agent_workbook_invalid_cell');
  return `<is><t xml:space="preserve">${xml(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''))}</t></is>`;
}

function columnName(index) {
  let remaining = index + 1;
  let name = '';
  while (remaining > 0) {
    remaining -= 1;
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26);
  }
  return name;
}

function sheetXml(sheet) {
  const width = Math.max(...sheet.rows.map(row => row.length));
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      if (value === null || value === undefined) return '';
      const type = typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 'inlineStr';
      return `<c r="${columnName(columnIndex)}${rowIndex + 1}" t="${type}">${cellValue(value)}</c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${width}" width="18" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name);
    const source = Buffer.from(content);
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(source.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

export function buildModelWorkbook(spec, notice = null) {
  if (!spec || typeof spec !== 'object' || !Array.isArray(spec.sheets)
    || spec.sheets.length < 1 || spec.sheets.length > MAX_SHEETS - (notice ? 1 : 0)) {
    throw new Error('result_agent_workbook_invalid_sheets');
  }
  const names = new Set();
  const inputSheets = [...spec.sheets];
  if (notice) inputSheets.push({ name: '数据范围说明', rows: [['注意'], [notice]] });
  const sheets = inputSheets.map((sheet, index) => {
    if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)
      || sheet.rows.length < 1 || sheet.rows.length > MAX_ROWS) {
      throw new Error('result_agent_workbook_invalid_sheet');
    }
    const name = sheet.name.trim();
    if (!name || name.length > 31 || /[\\/*?:\[\]]/.test(name) || names.has(name.toLowerCase())) {
      throw new Error('result_agent_workbook_invalid_sheet_name');
    }
    names.add(name.toLowerCase());
    const width = Math.max(...sheet.rows.map(row => Array.isArray(row) ? row.length : MAX_COLUMNS + 1));
    if (width < 1 || width > MAX_COLUMNS || sheet.rows.some(row => !Array.isArray(row))) {
      throw new Error('result_agent_workbook_invalid_rows');
    }
    return { name, rows: sheet.rows, index: index + 1 };
  });
  const workbookSheets = sheets.map(sheet => `<sheet name="${xml(sheet.name)}" sheetId="${sheet.index}" r:id="rId${sheet.index}"/>`).join('');
  const relationships = sheets.map(sheet => `<Relationship Id="rId${sheet.index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.index}.xml"/>`).join('');
  const overrides = sheets.map(sheet => `<Override PartName="/xl/worksheets/sheet${sheet.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const entries = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`],
    ...sheets.map(sheet => [`xl/worksheets/sheet${sheet.index}.xml`, sheetXml(sheet)]),
  ];
  const output = zip(entries);
  if (output.length > MAX_BYTES) throw new Error('result_agent_artifact_too_large');
  return output;
}
