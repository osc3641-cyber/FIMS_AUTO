(() => {
  if (globalThis.__FIMS_GRADUATION_RPA_CONTENT__) return;
  globalThis.__FIMS_GRADUATION_RPA_CONTENT__ = true;

  const DOCUMENT_TOKEN = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const normalizeCompact = (value) => normalizeText(value).replace(/\s+/g, '').toUpperCase();
  const normalizeName = (value) => normalizeText(value).toUpperCase();
  const normalizeStudentNo = (value) => String(value ?? '').replace(/\D/g, '');
  const digits = (value) => String(value ?? '').replace(/\D/g, '');

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function labelOf(element) {
    if (!element) return '';
    const parts = [
      element.innerText,
      element.textContent,
      element.value,
      element.title,
      element.alt,
      element.getAttribute?.('aria-label')
    ];
    return normalizeText(parts.filter(Boolean).join(' '));
  }

  function clickTarget(element) {
    if (!element) return false;
    const target = element.matches?.('img,span') ? (element.closest('a,button') || element) : element;
    target.scrollIntoView?.({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }

  function setNativeValue(input, value) {
    if (!input) return false;
    const next = String(value ?? '');
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) descriptor.set.call(input, next);
    else input.value = next;
    for (const type of ['input', 'change', 'keyup', 'blur']) {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    }
    return input.value === next;
  }

  function setChecked(input, checked) {
    if (!input) return false;
    if (Boolean(input.checked) !== Boolean(checked)) input.click();
    if (Boolean(input.checked) !== Boolean(checked)) {
      input.checked = Boolean(checked);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return Boolean(input.checked) === Boolean(checked);
  }

  function findClickableByExactText(text, root = document) {
    const expected = normalizeCompact(text);
    const elements = [...root.querySelectorAll('a,button,input[type="button"],input[type="submit"],img,[role="button"],[onclick]')];
    return elements.find((element) => isVisible(element) && normalizeCompact(labelOf(element)) === expected) || null;
  }

  function findSearchButton() {
    const field = document.querySelector('#sScholNo');
    const form = field?.closest('form') || document;
    const captured = form.querySelector('a[onclick*="fncSearchChgIntlStud"]');
    if (captured && isVisible(captured)) return captured;
    const image = form.querySelector('img[alt="조회"], img[title="조회"]');
    if (image && isVisible(image)) return image;

    const candidates = [...form.querySelectorAll('a,button,input[type="button"],input[type="submit"],[onclick]')]
      .filter(isVisible);
    return candidates.find((element) => normalizeCompact(labelOf(element)) === '조회') ||
      candidates.find((element) => /search|retrieve|select/i.test(element.getAttribute?.('onclick') || '')) ||
      null;
  }

  function tableHeaders(table) {
    if (!table) return [];
    // 레거시 FIMS는 표 안에 다른 표를 중첩한다. 바깥 레이아웃 표가 안쪽
    // 조회표/신고표의 행을 자기 행으로 가져가지 않도록 직접 소유 행만 사용한다.
    const rows = [...table.querySelectorAll('tr')]
      .filter((row) => row.closest('table') === table);
    const markers = ['성명', '학번', '외국인등록번호', '체류기간만료일', '사유발생일', '신고구분', '신고내용', '처리결과'];
    const scored = rows.map((row) => {
      const text = normalizeCompact(row.textContent);
      return { row, score: markers.filter((marker) => text.includes(normalizeCompact(marker))).length };
    }).sort((a, b) => b.score - a.score);
    const headerRow = (scored[0]?.score >= 2 ? scored[0].row : null) || rows.find((row) => row.querySelector('th')) || rows[0];
    return headerRow
      ? [...headerRow.children]
        .filter((cell) => cell.matches?.('th,td'))
        .map((cell) => normalizeCompact(cell.textContent))
      : [];
  }

  function headerIndex(headers, names) {
    const wanted = names.map(normalizeCompact);
    return headers.findIndex((header) => wanted.some((name) => header === name || header.includes(name)));
  }

  function cellText(cells, index) {
    return index >= 0 && cells[index] ? normalizeText(cells[index].textContent) : '';
  }

  function classifyTableHeaders(headers, options = {}) {
    const joined = (headers || []).map(normalizeCompact).join('|');
    const selectable = options.hasRowCheck === true || options.hasAllCheck === true;
    const hasPendingIdentity = joined.includes('사유발생일') &&
      (joined.includes('신고구분') || joined.includes('신고내용'));
    if (selectable && hasPendingIdentity) return 'PENDING';

    const hasSearchIdentity = joined.includes('외국인등록번호') || joined.includes('체류기간만료일');
    if (options.hasRowCheck === true && hasSearchIdentity && !joined.includes('사유발생일')) {
      return 'SEARCH_RESULTS';
    }
    return 'OTHER';
  }

  function classifyTable(table) {
    const ownedRowCheck = [...table.querySelectorAll('input[name="checkYn"]')]
      .some((input) => input.closest('table') === table);
    const ownedAllCheck = [...table.querySelectorAll('input[name="allCheck"]')]
      .some((input) => input.closest('table') === table);
    return classifyTableHeaders(tableHeaders(table), {
      hasRowCheck: ownedRowCheck,
      hasAllCheck: ownedAllCheck
    });
  }

  function ancestorTables(element) {
    const tables = [];
    let table = element?.closest?.('table') || null;
    while (table) {
      tables.push(table);
      table = table.parentElement?.closest?.('table') || null;
    }
    return tables;
  }

  function isPendingCheckbox(checkbox) {
    // 가장 가까운 의미 있는 데이터 표의 분류만 사용한다. 바깥 레이아웃 표가
    // PENDING으로 보이더라도 안쪽 검색결과 체크박스를 제외하지 않는다.
    for (const table of ancestorTables(checkbox)) {
      const type = classifyTable(table);
      if (type === 'SEARCH_RESULTS') return false;
      if (type === 'PENDING') return true;
    }
    return false;
  }

  function searchResultCheckboxes() {
    // FIMS는 조회 전에도 기본 학생 행을 표시하며, 조회 후에는 같은 표의 행만
    // 교체할 수 있다. 따라서 문서/표 교체 여부가 아니라 실제 checkYn 행을 읽는다.
    // 단, 아래쪽 실제 신고 대기명단의 checkYn은 고유 헤더로 분리하여 제외한다.
    const searchTables = [...document.querySelectorAll('table')]
      .filter((table) => classifyTable(table) === 'SEARCH_RESULTS');
    const classified = searchTables.flatMap((table) =>
      [...table.querySelectorAll('input[type="checkbox"][name="checkYn"][title]')]
        .filter((checkbox) => checkbox.closest('table') === table && isVisible(checkbox) && !checkbox.disabled)
    );
    if (classified.length) return [...new Set(classified)];

    // 고유 헤더를 읽지 못하는 경우에도 사용자가 제공한 실제 HTML selector로
    // 직접 찾는다. 실제 신고목록으로 판정된 체크박스만 제외한다.
    return [...document.querySelectorAll('input[type="checkbox"][name="checkYn"][title]')]
      .filter((checkbox) => isVisible(checkbox) && !checkbox.disabled && !isPendingCheckbox(checkbox));
  }

  function findPendingTable() {
    // 검색결과 표에도 allCheck가 있으므로 첫 번째 전체선택 표를 사용하면 안 된다.
    // 실제 유학생 신고목록 고유 헤더가 함께 있는 표만 대기명단으로 인정한다.
    return [...document.querySelectorAll('table')]
      .find((table) => classifyTable(table) === 'PENDING') || null;
  }

  function currentSearchCriteria() {
    return {
      name: normalizeText(document.querySelector('#sEkNm')?.value || ''),
      studentNo: normalizeStudentNo(document.querySelector('#sScholNo')?.value || ''),
      similarChecked: Boolean(document.querySelector('#sLikeYn')?.checked)
    };
  }

  function checkboxTitleMatches(title, expectedName) {
    const actual = normalizeName(title);
    const expected = normalizeName(expectedName);
    return Boolean(actual && expected && actual === expected);
  }

  function checkboxRowHasStudentNo(checkbox, studentNo) {
    const expected = normalizeStudentNo(studentNo);
    if (!expected) return false;
    const row = checkbox?.closest('tr');
    const table = row?.closest?.('table');
    const cells = row?.children ? [...row.children].filter((cell) => cell.matches?.('th,td')) : [];
    const headers = table ? tableHeaders(table) : [];
    const studentNoIndex = headerIndex(headers, ['학번']);

    // FIMS 결과표의 학번 열을 먼저 직접 읽는다. 셀 안에 공백·하이픈·숨은
    // 문자 등이 섞여도 숫자만 정규화해서 비교한다.
    const indexedStudentNo = normalizeStudentNo(cellText(cells, studentNoIndex));
    if (indexedStudentNo === expected) return true;

    // 헤더 구조가 달라진 경우에는 같은 행의 각 셀에서 7~12자리 숫자값을
    // 개별적으로 찾는다. 다른 셀의 숫자를 이어 붙이지 않는다.
    const candidates = cells.flatMap((cell) => {
      const text = normalizeText(cell.textContent || '');
      const runs = text.split(/[^0-9]+/).filter((value) => value.length >= 7 && value.length <= 12);
      const wholeCell = normalizeStudentNo(text);
      return wholeCell.length >= 7 && wholeCell.length <= 12 ? [wholeCell, ...runs] : runs;
    });
    if (candidates.includes(expected)) return true;

    const rowRuns = normalizeText(row?.textContent || '')
      .split(/[^0-9]+/)
      .filter((value) => value.length >= 7 && value.length <= 12);
    return rowRuns.includes(expected);
  }

  function readTargetSearchCheckbox(payload) {
    const checkboxes = searchResultCheckboxes();
    const body = normalizeCompact(document.body?.innerText || '');
    const noResult = body.includes('조회된결과가없습니다') || body.includes('조회결과가없습니다') || body.includes('총0건');
    const criteria = currentSearchCriteria();
    // 검색 조건은 mainFrame에 있고 결과 체크박스는 chgIntlStudFrame에 있다.
    // 결과 프레임에는 검색 입력칸이 없으므로 mainFrame에서 이미 검증한 조건을 사용한다.
    const criteriaAvailable = Boolean(document.querySelector('#sEkNm') && document.querySelector('#sScholNo'));
    const criteriaMatch = !criteriaAvailable || (
      normalizeName(criteria.name) === normalizeName(payload.name) &&
      normalizeStudentNo(criteria.studentNo) === normalizeStudentNo(payload.studentNo) &&
      criteria.similarChecked === true
    );

    const titleMatches = checkboxes.filter((checkbox) =>
      checkboxTitleMatches(checkbox.getAttribute('title'), payload.name)
    );
    // 이름만 같은 다른 학생을 선택하지 않도록 결과 행에서도 학번을 반드시
    // 다시 확인한다. 검색 조건을 올바르게 입력했더라도 최종 선택 기준은
    // 결과 행의 checkbox title(성명) + 같은 행의 학번 정확 일치다.
    const rowMatches = titleMatches.filter((checkbox) =>
      checkboxRowHasStudentNo(checkbox, payload.studentNo)
    );
    const resolved = rowMatches;
    const studentNoVerifiedInRow = rowMatches.length > 0;

    const state = !criteriaMatch
      ? 'WAIT'
      : resolved.length === 1
        ? 'FOUND'
        : resolved.length > 1
          ? 'AMBIGUOUS'
          : noResult
            ? 'NONE'
            : 'WAIT';
    const target = state === 'FOUND' ? resolved[0] : null;
    const availableTitles = checkboxes
      .map((checkbox) => normalizeText(checkbox.getAttribute('title') || ''))
      .filter(Boolean)
      .slice(0, 5);
    return {
      state,
      documentToken: DOCUMENT_TOKEN,
      criteria,
      criteriaAvailable,
      criteriaMatch,
      token: String(target?.value || ''),
      title: normalizeText(target?.getAttribute('title') || ''),
      matchCount: resolved.length,
      titleMatchCount: titleMatches.length,
      studentNoVerifiedInRow,
      candidateCount: checkboxes.length,
      availableTitles,
      signature: `${state}|${String(target?.value || '')}|${availableTitles.join('~')}`
    };
  }

  function selectTargetSearchCheckbox(payload) {
    const result = readTargetSearchCheckbox(payload);
    if (result.state !== 'FOUND') {
      return { ok: false, message: `성명 title 정확 일치 체크박스가 1건이 아닙니다: ${result.matchCount}건` };
    }
    const checkbox = searchResultCheckboxes().find((item) =>
      String(item.value || '') === String(result.token) &&
      checkboxTitleMatches(item.getAttribute('title'), payload.name)
    );
    if (!checkbox || !setChecked(checkbox, true)) {
      return { ok: false, message: '학생 이름 체크박스를 클릭하지 못했습니다.' };
    }
    return {
      ok: true,
      token: result.token,
      title: result.title,
      message: `${result.title} 체크박스 클릭 완료`
    };
  }

  function parsePendingRows() {
    const table = findPendingTable();
    if (!table) return { state: 'WAIT', rows: [] };

    const headers = tableHeaders(table);
    const nameIndex = headerIndex(headers, ['성명', '이름']);
    const studentNoIndex = headerIndex(headers, ['학번']);
    const dateIndex = headerIndex(headers, ['사유발생일']);
    const typeIndex = headerIndex(headers, ['신고구분']);

    const rows = [...table.querySelectorAll('input[name="checkYn"]')]
      .filter((checkbox) => checkbox.closest('table') === table)
      .map((checkbox) => {
      const tr = checkbox.closest('tr');
      const cells = tr ? [...tr.querySelectorAll('th,td')] : [];
      const rawName = cellText(cells, nameIndex) || normalizeText(checkbox.title || '');
      let studentNo = normalizeStudentNo(cellText(cells, studentNoIndex));
      if (!studentNo && tr) {
        const candidates = normalizeText(tr.textContent).match(/\b\d{7,12}\b/g) || [];
        studentNo = candidates.map(normalizeStudentNo).find((value) => value.length >= 7) || '';
      }

      const dateInput = tr?.querySelector('input[name="rsnHappYmd"], input[id*="rsnHappYmd"]');
      const typeSelect = tr?.querySelector('select[name="newDtlStsCd"], select[id*="newDtlStsCd"]');
      const typeOption = typeSelect?.selectedOptions?.[0];

      return {
        token: String(checkbox.value || ''),
        name: rawName,
        normalizedName: normalizeName(rawName),
        studentNo,
        reasonDate: normalizeText(dateInput?.value || cellText(cells, dateIndex)),
        reportTypeValue: String(typeSelect?.value || ''),
        reportTypeText: normalizeText(typeOption?.textContent || cellText(cells, typeIndex)),
        checked: Boolean(checkbox.checked),
        rowText: normalizeText(tr?.textContent || '')
      };
      });

    return { state: 'ROWS', rows };
  }

  function selectPendingTargets(payload) {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    const table = findPendingTable();
    if (!table || !targets.length) {
      return { ok: false, checked: 0, message: '선택할 이번 실행 대상 또는 유학생신고 목록이 없습니다.' };
    }

    const allCheck = [...table.querySelectorAll('input[name="allCheck"]')]
      .find((input) => input.closest('table') === table);
    if (allCheck) setChecked(allCheck, false);

    const rowChecks = [...table.querySelectorAll('input[name="checkYn"]')]
      .filter((item) => item.closest('table') === table && !item.disabled);
    for (const checkbox of rowChecks) setChecked(checkbox, false);

    const normalizedTargets = targets.map((target) => ({
      ...target,
      normalizedName: normalizeName(target.name),
      studentNo: normalizeStudentNo(target.studentNo)
    }));
    const selected = [];
    const missing = [];
    const duplicates = [];

    for (const target of normalizedTargets) {
      const matches = rowChecks.filter((checkbox) =>
        checkboxTitleMatches(checkbox.getAttribute('title'), target.name) &&
        checkboxRowHasStudentNo(checkbox, target.studentNo)
      );
      if (matches.length === 0) {
        missing.push({ name: target.name, studentNo: target.studentNo });
      } else if (matches.length > 1) {
        duplicates.push({ name: target.name, studentNo: target.studentNo, count: matches.length });
      } else {
        selected.push(matches[0]);
      }
    }

    if (missing.length || duplicates.length) {
      return {
        ok: false,
        checked: 0,
        missing,
        duplicates,
        message: `이번 실행 대상 선택 실패: 누락 ${missing.length}건 / 중복 ${duplicates.length}건`
      };
    }

    for (const checkbox of selected) setChecked(checkbox, true);
    const checkedRows = rowChecks.filter((checkbox) => checkbox.checked);
    const ok = checkedRows.length === normalizedTargets.length && selected.every((checkbox) => checkbox.checked);
    return {
      ok,
      total: rowChecks.length,
      checked: checkedRows.length,
      untouched: rowChecks.length - checkedRows.length,
      message: ok
        ? `이번 실행 대상 ${checkedRows.length}건만 선택 완료`
        : `이번 실행 대상 선택 검증 실패: ${checkedRows.length}/${normalizedTargets.length}건`
    };
  }

  function inspect() {
    const frameName = String(window.name || '');
    const path = String(location.pathname || '');
    return {
      href: location.href,
      title: document.title,
      documentToken: DOCUMENT_TOKEN,
      frameName,
      isSearchMainFrame: frameName === 'mainFrame' || path.endsWith('/ChgIntlStudListR.isi'),
      isSearchResultsFrame: frameName === 'chgIntlStudFrame' || path.endsWith('/ChgIntlStudPageR.isi'),
      isPendingListFrame: frameName === 'notiListFrame' || path.endsWith('/ChgIntlStudNotiListR.isi'),
      hasLogin: Boolean(document.querySelector('#userId') && document.querySelector('#userPasswd')),
      // #nMenuTreeHome15는 상위 메뉴 토글이고 실제 변동신고 이동 링크는
      // 수집본에서 확인된 #nMenuTreeHome16이다. 본문에 '변동신고'라는 FAQ가
      // 있는 mainFrame을 메뉴 프레임으로 오인하지 않는다.
      hasChangeMenu: Boolean(document.querySelector('#nMenuTreeHome16, a[href*="/isi/ChgIntlStudListR.isi"]')),
      hasChangeMenuParent: Boolean(document.querySelector('#nMenuTreeHome15')),
      hasSearchForm: Boolean(document.querySelector('#sScholNo') && document.querySelector('#sEkNm')),
      hasSearchResults: searchResultCheckboxes().length > 0,
      hasPendingTable: Boolean(findPendingTable()),
      hasSendButton: Boolean(document.querySelector('#button2 > td > a, a[onclick*="fncReqMoveNotiList"]')),
      hasBatchButton: Boolean(document.querySelector('a[onclick*="fncReqNotiMultiProc"]')),
      hasFinalButton: Boolean(document.querySelector('a[onclick*="fncReqNotiProc"]')),
      hasBatchPopup: Boolean(document.querySelector('#rsnHappYmd') && document.querySelector('#newDtlStsCd') && document.querySelector('#chgNotiTxt'))
    };
  }

  function fillLogin(payload) {
    const id = document.querySelector('#userId');
    const password = document.querySelector('#userPasswd');
    if (!id || !password) return { ok: false, message: '로그인 입력칸을 찾지 못했습니다.' };
    setNativeValue(id, payload.userId);
    setNativeValue(password, payload.password);
    return {
      ok: id.value === String(payload.userId) && password.value === String(payload.password),
      message: '로그인 정보 입력 완료'
    };
  }

  function clickLogin() {
    const direct = document.querySelector('a[onclick*="login" i], button[type="submit"], input[type="submit"]');
    const target = direct && isVisible(direct) ? direct : findClickableByExactText('로그인');
    return clickTarget(target) ? { ok: true } : { ok: false, message: '로그인 버튼을 찾지 못했습니다.' };
  }

  function clickChangeMenu() {
    // 반드시 실제 하위 메뉴 링크를 우선한다. 쉼표 선택자에 #15를 함께 넣으면
    // DOM 순서상 상위 토글이 먼저 선택되어 mainFrame 이동이 일어나지 않는다.
    const target = document.querySelector('#nMenuTreeHome16') ||
      document.querySelector('a[href*="/isi/ChgIntlStudListR.isi"]') ||
      findClickableByExactText('변동신고');
    return clickTarget(target) ? { ok: true } : { ok: false, message: '변동신고 메뉴를 찾지 못했습니다.' };
  }

  function prepareStudentSearch(payload) {
    const studentNo = document.querySelector('#sScholNo');
    const name = document.querySelector('#sEkNm');
    const similar = document.querySelector('#sLikeYn');
    if (!studentNo || !name || !similar) {
      return { ok: false, message: '학번·성명·유사 검색 요소를 찾지 못했습니다.' };
    }

    for (const checkbox of searchResultCheckboxes()) {
      if (checkbox.checked) setChecked(checkbox, false);
    }

    setNativeValue(studentNo, payload.studentNo);
    setNativeValue(name, payload.name);
    setChecked(similar, true);

    if (normalizeStudentNo(studentNo.value) !== normalizeStudentNo(payload.studentNo)) {
      return { ok: false, message: '학번 입력값 검증에 실패했습니다.' };
    }
    if (normalizeName(name.value) !== normalizeName(payload.name)) {
      return { ok: false, message: '성명 입력값 검증에 실패했습니다.' };
    }
    if (!similar.checked) return { ok: false, message: '유사 체크를 활성화하지 못했습니다.' };

    const search = findSearchButton();
    if (!search) return { ok: false, message: '조회 버튼을 찾지 못했습니다.' };
    clickTarget(search);
    return {
      ok: true,
      message: '조회 실행',
      requestedCriteria: {
        name: normalizeName(payload.name),
        studentNo: normalizeStudentNo(payload.studentNo),
        similarChecked: true
      },
      clickedAt: Date.now()
    };
  }

  function sendSelected() {
    const target = document.querySelector('#button2 > td > a, a[onclick*="fncReqMoveNotiList"]') ||
      findClickableByExactText('보내기');
    return clickTarget(target) ? { ok: true } : { ok: false, message: '보내기 버튼을 찾지 못했습니다.' };
  }

  function openBatchPopup() {
    const target = document.querySelector('a[onclick*="fncReqNotiMultiProc"]') || findClickableByExactText('신고내용일괄입력');
    return clickTarget(target) ? { ok: true } : { ok: false, message: '신고내용일괄입력 버튼을 찾지 못했습니다.' };
  }

  function fillBatchPopup(payload) {
    const reasonDate = document.querySelector('#rsnHappYmd');
    const reportType = document.querySelector('#newDtlStsCd');
    const reportText = document.querySelector('#chgNotiTxt');
    if (!reasonDate || !reportType || !reportText) {
      return { ok: false, message: '신고내용 일괄입력 필드를 찾지 못했습니다.' };
    }

    setNativeValue(reasonDate, payload.reasonDate);

    const options = [...reportType.options];
    const wantedLabel = normalizeCompact(payload.reportTypeText);
    const option = options.find((item) => String(item.value) === String(payload.reportTypeValue)) ||
      options.find((item) => normalizeCompact(item.textContent) === wantedLabel);
    if (!option) return { ok: false, message: `신고구분 선택지를 찾지 못했습니다: ${payload.reportTypeText}` };
    reportType.value = option.value;
    reportType.dispatchEvent(new Event('input', { bubbles: true }));
    reportType.dispatchEvent(new Event('change', { bubbles: true }));

    setNativeValue(reportText, payload.reportText);

    const ok = digits(reasonDate.value) === digits(payload.reasonDate) &&
      String(reportType.value) === String(option.value) &&
      reportText.value === String(payload.reportText);

    return {
      ok,
      values: {
        reasonDate: reasonDate.value,
        reportTypeValue: reportType.value,
        reportTypeText: normalizeText(reportType.selectedOptions?.[0]?.textContent || ''),
        reportText: reportText.value
      },
      message: ok ? '신고내용 입력 및 값 검증 완료' : '신고내용 입력값 검증 실패'
    };
  }

  function saveBatchPopup() {
    const exact = findClickableByExactText('저장');
    const fallback = [...document.querySelectorAll('a[onclick],button,input[type="button"],input[type="submit"]')]
      .filter(isVisible)
      .find((element) => /save|notimultiproc|notimultisave/i.test(element.getAttribute?.('onclick') || ''));
    const target = exact || fallback;
    return clickTarget(target) ? { ok: true } : { ok: false, message: '팝업의 저장 버튼을 찾지 못했습니다.' };
  }

  function clickFinalReport() {
    const target = document.querySelector('a[onclick*="fncReqNotiProc"]') || findClickableByExactText('신고처리');
    return clickTarget(target) ? { ok: true } : { ok: false, message: '신고처리 버튼을 찾지 못했습니다.' };
  }

  function handleAction(message) {
    const payload = message.payload || {};
    switch (message.action) {
      case 'INSPECT': return { ok: true, data: inspect() };
      case 'FILL_LOGIN': return fillLogin(payload);
      case 'CLICK_LOGIN': return clickLogin();
      case 'CLICK_CHANGE_MENU': return clickChangeMenu();
      case 'PREPARE_STUDENT_SEARCH': return prepareStudentSearch(payload);
      case 'READ_TARGET_SEARCH_CHECKBOX': return { ok: true, data: readTargetSearchCheckbox(payload) };
      case 'SELECT_TARGET_SEARCH_CHECKBOX': return selectTargetSearchCheckbox(payload);
      case 'SEND_SELECTED': return sendSelected();
      case 'READ_PENDING_ROWS': return { ok: true, data: parsePendingRows() };
      case 'SELECT_PENDING_TARGETS': return selectPendingTargets(payload);
      case 'OPEN_BATCH_POPUP': return openBatchPopup();
      case 'FILL_BATCH_POPUP': return fillBatchPopup(payload);
      case 'SAVE_BATCH_POPUP': return saveBatchPopup();
      case 'CLICK_FINAL_REPORT': return clickFinalReport();
      default: return { ok: false, message: `지원하지 않는 동작: ${message.action}` };
    }
  }

  if (globalThis.__FIMS_GRADUATION_RPA_TEST_HOOKS__) {
    Object.assign(globalThis.__FIMS_GRADUATION_RPA_TEST_HOOKS__, {
      classifyTableHeaders,
      classifyTable,
      checkboxTitleMatches,
      checkboxRowHasStudentNo,
      clickChangeMenu
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'FIMS_GRAD_RPA_ACTION') return;
    try {
      sendResponse(handleAction(message));
    } catch (error) {
      sendResponse({ ok: false, message: error?.message || String(error) });
    }
  });
})();
