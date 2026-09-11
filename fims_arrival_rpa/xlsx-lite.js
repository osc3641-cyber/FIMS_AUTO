/* global JSZip */
(() => {
  const REQUIRED_SHEETS = ['실행설정', '입국신고명단', '처리결과'];

  const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const compact = (value) => normalizeText(value).replace(/[\s_\-./()[\]]/g, '').toUpperCase();
  const studentNo = (value) => String(value ?? '').replace(/\D/g, '');

  function dateDigits(value, label) {
    const raw = String(value ?? '').trim();
    let valueDigits = raw.replace(/\D/g, '');
    if (!/^\d{8}$/.test(valueDigits) && /^\d{5}(?:\.\d+)?$/.test(raw)) {
      const serial = Number(raw);
      if (serial >= 1 && serial <= 80000) {
        const excelDate = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
        valueDigits = [
          excelDate.getUTCFullYear(),
          String(excelDate.getUTCMonth() + 1).padStart(2, '0'),
          String(excelDate.getUTCDate()).padStart(2, '0')
        ].join('');
      }
    }
    if (!/^\d{8}$/.test(valueDigits)) throw new Error(`${label}을 YYYY.MM.DD 또는 YYYYMMDD 형식으로 입력하세요.`);
    const year = Number(valueDigits.slice(0, 4));
    const month = Number(valueDigits.slice(4, 6));
    const day = Number(valueDigits.slice(6, 8));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
      throw new Error(`${label}이 유효한 날짜가 아닙니다.`);
    }
    return `${valueDigits.slice(0, 4)}.${valueDigits.slice(4, 6)}.${valueDigits.slice(6, 8)}`;
  }

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
    const admissionDateRaw = entries.get(compact('입학(복학)일자')) ?? entries.get(compact('입학일자')) ?? '';
    if (!workType.includes('입국')) throw new Error("실행설정의 업무구분은 '입국신고'여야 합니다.");
    return {
      workType,
      admissionDate: dateDigits(admissionDateRaw, '입학(복학)일자')
    };
  }

  function parseStudents(rows) {
    const header = findHeaderRow(rows, [['성명', '이름'], ['생년월일'], ['학번']]);
    if (!header) throw new Error("'입국신고명단' 시트에서 성명·생년월일·학번 열을 찾지 못했습니다.");
    const activeColumn = findColumn(header.headers, ['처리대상', '대상', '사용여부']);
    const nameColumn = findColumn(header.headers, ['성명', '이름']);
    const birthDateColumn = findColumn(header.headers, ['생년월일']);
    const studentNoColumn = findColumn(header.headers, ['학번']);
    const noteColumn = findColumn(header.headers, ['비고', '메모']);
    // 선택 항목. 비워두면 FIMS에 입력된 값을 그대로 둔다.
    const localRecommenderColumn = findColumn(header.headers, ['현지추천단체']);
    const localRecommenderTypeColumn = findColumn(header.headers, ['현지추천단체구분', '현지자매학교']);
    const lastSchoolColumn = findColumn(header.headers, ['최종출신학교']);
    const students = [];

    rows.slice(header.index + 1).forEach((row, offset) => {
      const rawName = normalizeText(row?.[nameColumn]);
      const rawBirthDate = row?.[birthDateColumn];
      const rawNo = studentNo(row?.[studentNoColumn]);
      const active = activeColumn < 0 ? 'Y' : normalizeText(row?.[activeColumn] || 'Y').toUpperCase();
      if (!rawName && !rawBirthDate && !rawNo) return;
      if (['N', 'NO', '아니오', '제외'].includes(active)) return;
      if (!rawName || !rawBirthDate || !rawNo) {
        throw new Error(`입국신고명단 ${header.index + offset + 2}행의 성명·생년월일·학번 중 빈 항목이 있습니다.`);
      }
      students.push({
        sequence: students.length + 1,
        sourceRow: header.index + offset + 2,
        name: rawName,
        birthDate: dateDigits(rawBirthDate, `입국신고명단 ${header.index + offset + 2}행 생년월일`),
        studentNo: rawNo,
        note: noteColumn >= 0 ? normalizeText(row?.[noteColumn]) : '',
        localRecommender: localRecommenderColumn >= 0 ? normalizeText(row?.[localRecommenderColumn]) : '',
        localRecommenderType: localRecommenderTypeColumn >= 0 ? normalizeText(row?.[localRecommenderTypeColumn]) : '',
        lastSchool: lastSchoolColumn >= 0 ? normalizeText(row?.[lastSchoolColumn]) : ''
      });
    });

    if (!students.length) throw new Error('처리할 입국신고 대상자가 없습니다.');

    const seen = new Map();
    for (const student of students) {
      const key = `${normalizeText(student.name).toUpperCase()}|${student.birthDate.replace(/\D/g, '')}|${student.studentNo}`;
      if (seen.has(key)) throw new Error(`중복 대상자: ${student.name} / ${student.birthDate} / ${student.studentNo}`);
      seen.set(key, true);
    }
    return students;
  }

  // 다운로드한 '처리결과' 엑셀을 다시 올렸을 때 지난 결과를 읽어온다.
  // 입국일자 미확인 학생을 골라 별도처리 섹션에 띄우는 데 쓴다.
  function parsePriorResults(rows) {
    const header = findHeaderRow(rows, [['성명', '이름'], ['생년월일'], ['학번'], ['처리결과']]);
    if (!header) return [];
    const nameColumn = findColumn(header.headers, ['성명', '이름']);
    const birthDateColumn = findColumn(header.headers, ['생년월일']);
    const studentNoColumn = findColumn(header.headers, ['학번']);
    const resultColumn = findColumn(header.headers, ['처리결과']);
    const arrivalColumn = findColumn(header.headers, ['확인된 입국일자', '입국일자']);
    const noteColumn = findColumn(header.headers, ['비고', '메모']);
    const detailColumn = findColumn(header.headers, ['상세메시지', '상세']);
    const stageColumn = findColumn(header.headers, ['단계']);
    const processedColumn = findColumn(header.headers, ['처리일시']);

    const entries = [];
    rows.slice(header.index + 1).forEach((row) => {
      const name = normalizeText(row?.[nameColumn]);
      const rawBirthDate = row?.[birthDateColumn];
      const no = studentNo(row?.[studentNoColumn]);
      const result = normalizeText(row?.[resultColumn]);
      if (!name || !rawBirthDate || !no || !result) return;
      let birthDate = '';
      try { birthDate = dateDigits(rawBirthDate, '처리결과 생년월일'); } catch (_) { return; }
      entries.push({
        name,
        birthDate,
        studentNo: no,
        result,
        stage: stageColumn >= 0 ? normalizeText(row?.[stageColumn]) : '',
        arrivalDate: arrivalColumn >= 0 ? normalizeText(row?.[arrivalColumn]) : '',
        note: noteColumn >= 0 ? normalizeText(row?.[noteColumn]) : '',
        detail: detailColumn >= 0 ? normalizeText(row?.[detailColumn]) : '',
        processedAt: processedColumn >= 0 ? normalizeText(row?.[processedColumn]) : ''
      });
    });
    return entries;
  }

  async function parseWorkbook(file) {
    if (!file || !/\.xlsx$/i.test(file.name || '')) throw new Error('.xlsx 파일을 선택하세요.');
    const bytes = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(bytes);
    const sheets = await workbookIndex(zip);
    const missing = REQUIRED_SHEETS.filter((name) => !sheets.has(name));
    if (missing.length) throw new Error(`필수 시트가 없습니다: ${missing.join(', ')}`);

    const strings = await sharedStrings(zip);
    const [configRows, studentRows, resultRows] = await Promise.all([
      sheetRows(zip, sheets.get('실행설정'), strings),
      sheetRows(zip, sheets.get('입국신고명단'), strings),
      sheetRows(zip, sheets.get('처리결과'), strings)
    ]);

    return {
      originalBytes: bytes,
      fileName: file.name,
      config: parseConfig(configRows),
      students: parseStudents(studentRows),
      priorResults: parsePriorResults(resultRows)
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

    const titleStyles = styleMap(existingDoc, 1, 10);
    const noteStyles = styleMap(existingDoc, 2, 10);
    const headerStyles = styleMap(existingDoc, 4, 10);
    const bodyStyles = styleMap(existingDoc, 5, 10);

    const headers = ['순번', '성명', '생년월일', '학번', '단계', '처리결과', '확인된 입국일자', '비고', '상세메시지', '처리일시'];
    const rows = [];
    rows.push(`<row r="1" ht="28" customHeight="1">${inlineCell(1, 0, 'FIMS 입국신고 처리결과', titleStyles[0])}</row>`);
    rows.push(`<row r="2" ht="20" customHeight="1">${inlineCell(2, 0, `생성일시: ${new Date().toLocaleString('ko-KR')}`, noteStyles[0])}</row>`);
    rows.push(`<row r="4" ht="24" customHeight="1">${headers.map((value, index) => inlineCell(4, index, value, headerStyles[index])).join('')}</row>`);

    results.forEach((result, index) => {
      const rowNumber = index + 5;
      const values = [
        result.sequence ?? index + 1,
        result.name ?? '',
        result.birthDate ?? '',
        result.studentNo ?? '',
        result.stage ?? '',
        result.result ?? '',
        result.arrivalDate ?? '',
        result.note ?? '',
        result.detail ?? '',
        result.processedAt ?? ''
      ];
      rows.push(`<row r="${rowNumber}" ht="21" customHeight="1">${values.map((value, column) => inlineCell(rowNumber, column, value, bodyStyles[column])).join('')}</row>`);
    });

    const lastRow = Math.max(4, results.length + 4);
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="A1:J${lastRow}"/>
  <sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>
    <col min="1" max="1" width="8" customWidth="1"/>
    <col min="2" max="2" width="28" customWidth="1"/>
    <col min="3" max="3" width="16" customWidth="1"/>
    <col min="4" max="4" width="16" customWidth="1"/>
    <col min="5" max="5" width="20" customWidth="1"/>
    <col min="6" max="6" width="24" customWidth="1"/>
    <col min="7" max="7" width="20" customWidth="1"/>
    <col min="8" max="8" width="35" customWidth="1"/>
    <col min="9" max="9" width="62" customWidth="1"/>
    <col min="10" max="10" width="22" customWidth="1"/>
  </cols>
  <sheetData>${rows.join('')}</sheetData>
  <autoFilter ref="A4:J${lastRow}"/>
  <mergeCells count="2"><mergeCell ref="A1:J1"/><mergeCell ref="A2:J2"/></mergeCells>
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
    parsePriorResults,
    parseWorkbook,
    exportResults
  };
})();
