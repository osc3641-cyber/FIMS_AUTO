/* global JSZip */
(() => {
  const REQUIRED_SHEETS = ['실행설정', '졸업신고명단', '처리결과'];
  const REPORT_TYPES = [
    ['A', '유학생미등록'],
    ['B', '유학생자퇴'],
    ['C', '유학생휴학'],
    ['D', '유학생제적'],
    ['N', '유학생 학위교류(교환학생)'],
    ['I', '어학연수생미등록'],
    ['J', '어학연수생자퇴'],
    ['K', '어학연수생제적'],
    ['4', '소재불명'],
    ['3', '사망'],
    ['F', '유학생/어학연수생 한국국적취득'],
    ['E', '유학생졸업/연수종료'],
    ['L', '어학연수생연수종료'],
    ['M', '비재학생으로 전환'],
    ['O', '외국인 등록기한 도과자'],
    ['P', '기타']
  ];

  const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const compact = (value) => normalizeText(value).replace(/[\s_\-./()[\]]/g, '').toUpperCase();
  const studentNo = (value) => String(value ?? '').replace(/\D/g, '');

  function parseXml(xml, fileName) {
    const documentNode = new DOMParser().parseFromString(xml, 'application/xml');
    const error = documentNode.querySelector('parsererror');
    if (error) throw new Error(`${fileName} XML을 읽지 못했습니다.`);
    return documentNode;
  }

  function localElements(root, localName) {
    return [...root.getElementsByTagNameNS('*', localName)];
  }

  function normalizeZipPath(path) {
    const parts = [];
    for (const part of String(path).replace(/^\//, '').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return parts.join('/');
  }

  function columnIndex(reference) {
    const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || 'A';
    let value = 0;
    for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
    return value - 1;
  }

  function columnLetters(index) {
    let value = index + 1;
    let letters = '';
    while (value > 0) {
      const remainder = (value - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      value = Math.floor((value - 1) / 26);
    }
    return letters;
  }

  async function workbookIndex(zip) {
    const workbookFile = zip.file('xl/workbook.xml');
    const relsFile = zip.file('xl/_rels/workbook.xml.rels');
    if (!workbookFile || !relsFile) throw new Error('올바른 .xlsx 통합문서가 아닙니다.');

    const [workbookXml, relsXml] = await Promise.all([workbookFile.async('text'), relsFile.async('text')]);
    const workbookDoc = parseXml(workbookXml, 'xl/workbook.xml');
    const relsDoc = parseXml(relsXml, 'xl/_rels/workbook.xml.rels');
    const relationships = new Map(
      localElements(relsDoc, 'Relationship').map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')])
    );

    const sheets = new Map();
    for (const sheet of localElements(workbookDoc, 'sheet')) {
      const name = sheet.getAttribute('name');
      const relationshipId = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const target = relationships.get(relationshipId);
      if (!name || !target) continue;
      const path = target.startsWith('/') ? normalizeZipPath(target) : normalizeZipPath(`xl/${target}`);
      sheets.set(name, { name, path, relationshipId });
    }
    return sheets;
  }

  async function sharedStrings(zip) {
    const file = zip.file('xl/sharedStrings.xml');
    if (!file) return [];
    const documentNode = parseXml(await file.async('text'), 'xl/sharedStrings.xml');
    return localElements(documentNode, 'si').map((item) =>
      localElements(item, 't').map((textNode) => textNode.textContent || '').join('')
    );
  }

  function cellValue(cell, strings) {
    const type = cell.getAttribute('t') || '';
    if (type === 'inlineStr') return localElements(cell, 't').map((node) => node.textContent || '').join('');
    const value = localElements(cell, 'v')[0]?.textContent ?? '';
    if (type === 's') return strings[Number(value)] ?? '';
    if (type === 'b') return value === '1';
    return value;
  }

  async function sheetRows(zip, sheetInfo, strings) {
    const file = zip.file(sheetInfo.path);
    if (!file) throw new Error(`${sheetInfo.name} 시트 파일이 없습니다.`);
    const documentNode = parseXml(await file.async('text'), sheetInfo.path);
    const rowNodes = localElements(documentNode, 'row');
    const rows = [];

    for (const rowNode of rowNodes) {
      const rowNumber = Number(rowNode.getAttribute('r') || rows.length + 1);
      const row = [];
      for (const cell of localElements(rowNode, 'c')) {
        const index = columnIndex(cell.getAttribute('r'));
        row[index] = cellValue(cell, strings);
      }
      rows[rowNumber - 1] = row;
    }
    return rows.map((row) => row || []);
  }

  function findHeaderRow(rows, requiredHeaders) {
    const wanted = requiredHeaders.map((group) => group.map(compact));
    for (let index = 0; index < rows.length; index += 1) {
      const headers = (rows[index] || []).map(compact);
      const ok = wanted.every((group) => headers.some((header) => group.includes(header)));
      if (ok) return { index, headers };
    }
    return null;
  }

  function findColumn(headers, names) {
    const wanted = names.map(compact);
    return headers.findIndex((header) => wanted.includes(header));
  }

  function parseConfig(rows) {
    const header = findHeaderRow(rows, [['항목', '설정항목'], ['입력값', '값']]);
    if (!header) throw new Error("'실행설정' 시트에서 항목·입력값 열을 찾지 못했습니다.");
    const itemColumn = findColumn(header.headers, ['항목', '설정항목']);
    const valueColumn = findColumn(header.headers, ['입력값', '값']);
    const entries = new Map();

    for (const row of rows.slice(header.index + 1)) {
      const key = normalizeText(row?.[itemColumn]);
      if (!key) continue;
      entries.set(compact(key), row?.[valueColumn] ?? '');
    }

    const workType = normalizeText(entries.get(compact('업무구분')) || '');
    const reasonDateRaw = String(entries.get(compact('사유발생일')) ?? '');
    const reportTypeRaw = normalizeText(entries.get(compact('신고구분')) || '');
    const reportText = String(entries.get(compact('신고내용')) ?? '');

    if (!workType.includes('졸업')) throw new Error("실행설정의 업무구분은 '졸업신고'여야 합니다.");
    let dateDigits = reasonDateRaw.replace(/\D/g, '');
    if (!/^\d{8}$/.test(dateDigits) && /^\d{5}(?:\.\d+)?$/.test(reasonDateRaw.trim())) {
      const serial = Number(reasonDateRaw);
      if (serial >= 20000 && serial <= 80000) {
        const excelDate = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
        dateDigits = [
          excelDate.getUTCFullYear(),
          String(excelDate.getUTCMonth() + 1).padStart(2, '0'),
          String(excelDate.getUTCDate()).padStart(2, '0')
        ].join('');
      }
    }
    if (!/^\d{8}$/.test(dateDigits)) throw new Error('사유발생일을 YYYY.MM.DD 또는 YYYYMMDD 형식으로 입력하세요.');
    const year = Number(dateDigits.slice(0, 4));
    const month = Number(dateDigits.slice(4, 6));
    const day = Number(dateDigits.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new Error('사유발생일이 유효한 날짜가 아닙니다.');
    }

    const reportType = REPORT_TYPES.find(([code, label]) =>
      compact(reportTypeRaw) === compact(label) || compact(reportTypeRaw) === compact(`${code} ${label}`)
    );
    if (!reportType) throw new Error(`신고구분이 FIMS 선택지와 일치하지 않습니다: ${reportTypeRaw || '(빈값)'}`);
    if (!reportText || !reportText.trim() || reportText.includes('[입력 필요]')) {
      throw new Error('실행설정의 신고내용을 입력하세요.');
    }
    if (reportText.length > 100) throw new Error(`신고내용은 100자 이하여야 합니다. 현재 ${reportText.length}자입니다.`);

    return {
      workType,
      reasonDate: `${dateDigits.slice(0, 4)}.${dateDigits.slice(4, 6)}.${dateDigits.slice(6, 8)}`,
      reportTypeValue: reportType[0],
      reportTypeText: reportType[1],
      reportText
    };
  }

  function parseStudents(rows) {
    const header = findHeaderRow(rows, [['성명', '이름'], ['학번']]);
    if (!header) throw new Error("'졸업신고명단' 시트에서 성명·학번 열을 찾지 못했습니다.");
    const activeColumn = findColumn(header.headers, ['처리대상', '대상', '사용여부']);
    const nameColumn = findColumn(header.headers, ['성명', '이름']);
    const studentNoColumn = findColumn(header.headers, ['학번']);
    const students = [];

    rows.slice(header.index + 1).forEach((row, offset) => {
      const rawName = normalizeText(row?.[nameColumn]);
      const rawNo = studentNo(row?.[studentNoColumn]);
      const active = activeColumn < 0 ? 'Y' : normalizeText(row?.[activeColumn] || 'Y').toUpperCase();
      if (!rawName && !rawNo) return;
      if (['N', 'NO', '아니오', '제외'].includes(active)) return;
      if (!rawName || !rawNo) {
        throw new Error(`졸업신고명단 ${header.index + offset + 2}행의 성명 또는 학번이 비어 있습니다.`);
      }
      students.push({
        sequence: students.length + 1,
        sourceRow: header.index + offset + 2,
        name: rawName,
        studentNo: rawNo
      });
    });

    if (!students.length) throw new Error('처리할 졸업신고 대상자가 없습니다.');

    const seen = new Map();
    for (const student of students) {
      const key = `${normalizeText(student.name).toUpperCase()}|${student.studentNo}`;
      if (seen.has(key)) throw new Error(`중복 대상자: ${student.name} / ${student.studentNo}`);
      seen.set(key, true);
    }
    return students;
  }

  async function parseWorkbook(file) {
    if (!file || !/\.xlsx$/i.test(file.name || '')) throw new Error('.xlsx 파일을 선택하세요.');
    const bytes = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(bytes);
    const sheets = await workbookIndex(zip);
    const missing = REQUIRED_SHEETS.filter((name) => !sheets.has(name));
    if (missing.length) throw new Error(`필수 시트가 없습니다: ${missing.join(', ')}`);

    const strings = await sharedStrings(zip);
    const [configRows, studentRows] = await Promise.all([
      sheetRows(zip, sheets.get('실행설정'), strings),
      sheetRows(zip, sheets.get('졸업신고명단'), strings)
    ]);

    return {
      originalBytes: bytes,
      fileName: file.name,
      config: parseConfig(configRows),
      students: parseStudents(studentRows)
    };
  }

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function styleMap(documentNode, rowNumber, columnCount) {
    const row = localElements(documentNode, 'row').find((item) => Number(item.getAttribute('r')) === rowNumber);
    const styles = Array(columnCount).fill('');
    if (!row) return styles;
    for (const cell of localElements(row, 'c')) {
      const index = columnIndex(cell.getAttribute('r'));
      if (index >= 0 && index < columnCount) styles[index] = cell.getAttribute('s') || '';
    }
    return styles;
  }

  function inlineCell(row, column, value, style = '') {
    const ref = `${columnLetters(column)}${row}`;
    const styleAttribute = style !== '' ? ` s="${escapeXml(style)}"` : '';
    return `<c r="${ref}"${styleAttribute} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }

  async function exportResults(originalBytes, results) {
    const zip = await JSZip.loadAsync(originalBytes.slice(0));
    const sheets = await workbookIndex(zip);
    const resultSheet = sheets.get('처리결과');
    if (!resultSheet) throw new Error("'처리결과' 시트를 찾지 못했습니다.");
    const existingXml = await zip.file(resultSheet.path).async('text');
    const existingDoc = parseXml(existingXml, resultSheet.path);

    const titleStyles = styleMap(existingDoc, 1, 7);
    const noteStyles = styleMap(existingDoc, 2, 7);
    const headerStyles = styleMap(existingDoc, 4, 7);
    const bodyStyles = styleMap(existingDoc, 5, 7);

    const headers = ['순번', '성명', '학번', '단계', '처리결과', '상세메시지', '처리일시'];
    const rows = [];
    rows.push(`<row r="1" ht="28" customHeight="1">${inlineCell(1, 0, 'FIMS 졸업신고 처리결과', titleStyles[0])}</row>`);
    rows.push(`<row r="2" ht="20" customHeight="1">${inlineCell(2, 0, `생성일시: ${new Date().toLocaleString('ko-KR')}`, noteStyles[0])}</row>`);
    rows.push(`<row r="4" ht="24" customHeight="1">${headers.map((value, index) => inlineCell(4, index, value, headerStyles[index])).join('')}</row>`);

    results.forEach((result, index) => {
      const rowNumber = index + 5;
      const values = [
        result.sequence ?? index + 1,
        result.name ?? '',
        result.studentNo ?? '',
        result.stage ?? '',
        result.result ?? '',
        result.detail ?? '',
        result.processedAt ?? ''
      ];
      rows.push(`<row r="${rowNumber}" ht="21" customHeight="1">${values.map((value, column) => inlineCell(rowNumber, column, value, bodyStyles[column])).join('')}</row>`);
    });

    const lastRow = Math.max(4, results.length + 4);
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:G${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>
    <col min="1" max="1" width="8" customWidth="1"/>
    <col min="2" max="2" width="28" customWidth="1"/>
    <col min="3" max="3" width="16" customWidth="1"/>
    <col min="4" max="4" width="20" customWidth="1"/>
    <col min="5" max="5" width="24" customWidth="1"/>
    <col min="6" max="6" width="62" customWidth="1"/>
    <col min="7" max="7" width="22" customWidth="1"/>
  </cols>
  <sheetData>${rows.join('')}</sheetData>
  <autoFilter ref="A4:G${lastRow}"/>
  <mergeCells count="2"><mergeCell ref="A1:G1"/><mergeCell ref="A2:G2"/></mergeCells>
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
</worksheet>`;

    zip.file(resultSheet.path, xml);
    return zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  globalThis.FimsXlsx = {
    REPORT_TYPES,
    parseWorkbook,
    exportResults
  };
})();
