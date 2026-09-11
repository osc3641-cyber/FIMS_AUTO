(() => {
  if (globalThis.__FIMS_ARRIVAL_RPA_CONTENT__) return;
  globalThis.__FIMS_ARRIVAL_RPA_CONTENT__ = true;

  const FIMS_NAME_MAX_LENGTH = 38;
  const DOCUMENT_TOKEN = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const normalizeCompact = (value) => normalizeText(value).replace(/\s+/g, '').toUpperCase();
  const normalizeName = (value) => normalizeText(value)
    .replace(/[,，]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const normalizeFimsName = (value) => normalizeName(value).slice(0, FIMS_NAME_MAX_LENGTH).trim();
  const digits = (value) => String(value ?? '').replace(/\D/g, '');

  function sameFimsName(left, right) {
    const a = normalizeFimsName(left);
    const b = normalizeFimsName(right);
    return Boolean(a && b && a === b);
  }

  function formatDate(value) {
    const valueDigits = digits(value);
    return /^\d{8}$/.test(valueDigits)
      ? `${valueDigits.slice(0, 4)}.${valueDigits.slice(4, 6)}.${valueDigits.slice(6, 8)}`
      : normalizeText(value);
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function labelOf(element) {
    if (!element) return '';
    return normalizeText([
      element.innerText,
      element.textContent,
      element.value,
      element.title,
      element.alt,
      element.getAttribute?.('aria-label')
    ].filter(Boolean).join(' '));
  }

  function clickTarget(element) {
    if (!element) return false;
    const target = element.matches?.('img,span') ? (element.closest('a,button') || element) : element;
    target.scrollIntoView?.({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }

  function scheduleClick(element) {
    if (!element) return false;
    setTimeout(() => clickTarget(element), 25);
    return true;
  }

  function setNativeValue(input, value) {
    if (!input) return false;
    const next = String(value ?? '');
    input.focus?.();
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, next);
    else input.value = next;
    try {
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: next }));
    } catch (_) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return String(input.value ?? '') === next;
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
    return [...root.querySelectorAll('a,button,input[type="button"],input[type="submit"],input[type="image"],img,[role="button"],[onclick]')]
      .find((element) => isVisible(element) && normalizeCompact(labelOf(element)) === expected) || null;
  }

  function findSearchButton() {
    const field = document.querySelector('#sEkNm');
    const form = field?.closest('form') || document;
    const captured = form.querySelector('a[onclick*="fncSearchPage"]');
    if (captured && isVisible(captured)) return captured;
    const image = form.querySelector('img[alt="조회"], img[title="조회"]');
    if (image && isVisible(image)) return image;
    return findClickableByExactText('조회', form);
  }

  function findSaveButton() {
    const captured = document.querySelector('a[onclick*="fncSave"]');
    if (captured && isVisible(captured)) return captured;
    return findClickableByExactText('저장');
  }

  function detailLinks() {
    const captured = [...document.querySelectorAll('a[title="상세조회"]')];
    const fallback = [...document.querySelectorAll('a[onclick*="fncGetDetail"]')];
    return [...new Set([...captured, ...fallback])].filter(isVisible);
  }

  function linkStudentName(link) {
    const direct = normalizeText(link?.textContent || '');
    if (direct && normalizeCompact(direct) !== '상세조회') return direct;
    const row = link?.closest('tr');
    if (!row) return '';
    const cells = [...row.children].filter((cell) => cell.matches?.('th,td'));
    const nameCell = cells.find((cell) => {
      const text = normalizeText(cell.textContent);
      return /[A-Za-z]{2}/.test(text) && !/상세조회/.test(text);
    });
    return normalizeText(nameCell?.textContent || '');
  }

  function resultNameMatches(displayedName, expectedName) {
    if (sameFimsName(displayedName, expectedName)) return true;
    const displayed = normalizeText(displayedName);
    if (!/(?:\.{3}|…)$/.test(displayed)) return false;
    const prefix = normalizeFimsName(displayed.replace(/(?:\.{3}|…)$/, '').trim());
    const expected = normalizeFimsName(expectedName);
    return Boolean(prefix.length >= 6 && expected.startsWith(prefix));
  }

  function resolveDetailCandidate({ criteriaMatch, candidates, noResult, expectedName }) {
    const safeCandidates = Array.isArray(candidates) ? candidates : [];
    const matches = safeCandidates.filter((candidate) => resultNameMatches(candidate.name, expectedName));
    if (!criteriaMatch) {
      return { state: 'WAIT', target: null, matches, matchStrategy: '' };
    }
    if (matches.length === 1) {
      return { state: 'FOUND', target: matches[0], matches, matchStrategy: 'name-match' };
    }
    if (matches.length > 1) {
      return { state: 'AMBIGUOUS', target: null, matches, matchStrategy: '' };
    }
    if (safeCandidates.length === 1) {
      // 검색조건(성명·생년월일·유사)이 그대로이고 상세조회 링크가 딱 1건이면
      // 화면의 말줄임표와 무관하게 연다. 수정 전 상세화면에서 신원을 다시 검증한다.
      return { state: 'FOUND', target: safeCandidates[0], matches, matchStrategy: 'single-detail-link' };
    }
    if (noResult && safeCandidates.length === 0) {
      return { state: 'NONE', target: null, matches, matchStrategy: '' };
    }
    if (safeCandidates.length > 0) {
      return { state: 'NOT_FOUND', target: null, matches, matchStrategy: '' };
    }
    return { state: 'WAIT', target: null, matches, matchStrategy: '' };
  }

  function currentSearchCriteria() {
    return {
      name: normalizeText(document.querySelector('#sEkNm')?.value || ''),
      birthDate: formatDate(document.querySelector('#sBirthYmd')?.value || ''),
      similarChecked: Boolean(document.querySelector('#sLikeYn')?.checked)
    };
  }

  function readArrivalSearchResult(payload) {
    const criteria = currentSearchCriteria();
    const criteriaMatch = sameFimsName(criteria.name, payload.name) &&
      digits(criteria.birthDate) === digits(payload.birthDate) &&
      criteria.similarChecked === true;
    const links = detailLinks();
    const candidates = links.map((link, index) => ({ index, name: linkStudentName(link), link }));
    const body = normalizeCompact(document.body?.innerText || '');
    const noResult = body.includes('조회된결과가없습니다') ||
      body.includes('조회결과가없습니다') ||
      body.includes('검색된결과가없습니다') ||
      body.includes('총0건');
    const resolved = resolveDetailCandidate({
      criteriaMatch,
      candidates,
      noResult,
      expectedName: payload.name
    });
    const { state, target, matches, matchStrategy } = resolved;
    return {
      state,
      documentToken: DOCUMENT_TOKEN,
      criteria,
      criteriaMatch,
      targetIndex: target?.index ?? -1,
      targetName: target?.name || '',
      matchStrategy,
      matchCount: matches.length,
      candidateCount: candidates.length,
      availableNames: candidates.map((candidate) => candidate.name).filter(Boolean).slice(0, 10),
      signature: `${state}|${target?.index ?? -1}|${matchStrategy}|${candidates.map((candidate) => candidate.name).join('~')}`
    };
  }

  function openArrivalDetail(payload) {
    const result = readArrivalSearchResult(payload);
    if (result.state !== 'FOUND') {
      return { ok: false, message: `성명·생년월일 조회 결과가 정확히 1건이 아닙니다: ${result.matchCount}건` };
    }
    const link = detailLinks()[result.targetIndex];
    if (!link || !scheduleClick(link)) return { ok: false, message: '상세조회 링크를 클릭하지 못했습니다.' };
    const targetName = result.targetName || normalizeFimsName(payload.name);
    return {
      ok: true,
      name: targetName,
      matchStrategy: result.matchStrategy,
      message: `${targetName} 상세조회 클릭 완료${result.matchStrategy === 'single-detail-link' ? ' / 단일 링크 선택 후 상세화면 재검증 예정' : ''}`
    };
  }

  function readLabeledValue(labels) {
    const expected = labels.map(normalizeCompact);
    const rows = [...document.querySelectorAll('tr')];
    for (const row of rows) {
      const cells = [...row.children].filter((cell) => cell.matches?.('th,td'));
      for (let index = 0; index < cells.length; index += 1) {
        const cellLabel = normalizeCompact(cells[index].textContent).replace(/[＊*:：]/g, '');
        if (!expected.some((label) => cellLabel === label || cellLabel.startsWith(label))) continue;
        for (let valueIndex = index + 1; valueIndex < cells.length; valueIndex += 1) {
          const input = cells[valueIndex].querySelector('input,select,textarea');
          const value = normalizeText(input?.value || cells[valueIndex].textContent || '');
          if (value) return value;
        }
      }
    }
    const labelNodes = [...document.querySelectorAll('th,td,dt,label,span')];
    const labelNode = labelNodes.find((node) => {
      const value = normalizeCompact(node.textContent).replace(/[＊*:：]/g, '');
      return expected.some((label) => value === label || value.startsWith(label));
    });
    const sibling = labelNode?.nextElementSibling;
    const input = sibling?.querySelector?.('input,select,textarea');
    return normalizeText(input?.value || sibling?.textContent || '');
  }

  function readDetailData(payload = {}) {
    const bodyText = normalizeText(document.body?.innerText || document.body?.textContent || '');
    const inputName = normalizeText(document.querySelector('#ekNm')?.value || '');
    const inputBirthDate = normalizeText(document.querySelector('#birthYmd')?.value || '');
    const inputStudentNo = normalizeText(document.querySelector('#scholNo')?.value || '');
    const inputAdmissionDate = normalizeText(document.querySelector('#admsnYmd')?.value || '');
    const inputArrivalDate = normalizeText(document.querySelector('#eYmd')?.value || '');
    const name = inputName || readLabeledValue(['성명', '이름']);
    const birthDate = inputBirthDate || readLabeledValue(['생년월일']);
    const studentNo = inputStudentNo || readLabeledValue(['학번']);
    const admissionDate = inputAdmissionDate || readLabeledValue(['입학(복학)일자', '입학일자']);
    const markedMatch = bodyText.match(/(\d{4}[.\/-]\d{2}[.\/-]\d{2})\s*\(\s*입국\s*\)/);
    const arrivalDate = normalizeText(markedMatch?.[1] || inputArrivalDate || '');
    // 수정폼(DtlRU)에 그대로 남는 경우 본문에 "(입국)" 문구가 없을 수 있다.
    // 그때는 #entrYN=N(=입국) + 읽기전용 #eYmd 날짜를 저장 성공 근거로 인정한다.
    const arrivalSelect = document.querySelector('#entrYN');
    const arrivalCode = normalizeText(arrivalSelect?.value || '');
    const arrivalCodeText = normalizeText(arrivalSelect?.options?.[arrivalSelect.selectedIndex]?.text || '');
    const arrivalConfirmedByForm = Boolean(
      arrivalCode === 'N' && arrivalCodeText === '입국' && /^\d{4}[.\/-]\d{2}[.\/-]\d{2}$/.test(normalizeText(inputArrivalDate))
    );
    const expectedName = normalizeFimsName(payload.name || '');
    const expectedBirth = digits(payload.birthDate || '');
    const bodyNamePresent = expectedName ? normalizeName(bodyText).includes(expectedName) : false;
    const bodyBirthPresent = expectedBirth ? digits(bodyText).includes(expectedBirth) : false;
    return {
      documentToken: DOCUMENT_TOKEN,
      name,
      birthDate,
      studentNo,
      admissionDate,
      arrivalDate,
      arrivalMarked: Boolean(markedMatch),
      arrivalCode,
      arrivalCodeText,
      arrivalConfirmed: Boolean(markedMatch) || arrivalConfirmedByForm,
      nameMatches: Boolean(expectedName && (sameFimsName(name, payload.name) || bodyNamePresent)),
      birthDateMatches: Boolean(expectedBirth && (digits(birthDate) === expectedBirth || bodyBirthPresent)),
      url: location.href
    };
  }

  function inspect() {
    const pathname = String(location.pathname || '');
    // 수집본 기준 실제 화면 URL은 3가지다.
    //   IntlStudBaInfoDtlR.xec  : 읽기 전용 상세(입력칸 없음, 수정/목록 링크만)
    //   IntlStudBaInfoDtlRU.xec : 수정 폼(scholNo·entrYN·admsnYmd·eYmd 보유)
    //   IntlStudBaInfoU.xec     : 수정 계열 화면
    // 이전 정규식 /IntlStudBaInfo(?:DtlR|U)\.xec/ 는 DtlRU를 매칭하지 못했다.
    const isStudentPageUrl = /IntlStudBaInfo(?:DtlRU|DtlR|U)\.xec/i.test(pathname);
    const hasArrivalEditForm = Boolean(document.querySelector('#scholNo') && document.querySelector('#entrYN') && document.querySelector('#admsnYmd'));
    const hasStudentDetailView = !hasArrivalEditForm && Boolean(
      isStudentPageUrl ||
      document.querySelector('a[title="수정"], a[onclick*="fncUpdate"], a[title="목록"], a[onclick*="fncList"]')
    );
    return {
      documentToken: DOCUMENT_TOKEN,
      url: location.href,
      windowName: window.name || '',
      hasLogin: Boolean(document.querySelector('#userId') && document.querySelector('#userPasswd')),
      hasStudentInfoParentMenu: Boolean(document.querySelector('#nMenuTreeHome6')),
      hasStudentBasicMenu: Boolean(document.querySelector('#nMenuTreeHome7')),
      hasBasicSearchForm: Boolean(document.querySelector('#sEkNm') && document.querySelector('#sBirthYmd') && document.querySelector('#sLikeYn')),
      hasDetailLinks: detailLinks().length > 0,
      hasArrivalEditForm,
      hasStudentDetailView,
      isStudentPageUrl,
      // 저장 후 FIMS가 상세(DtlR)로 가든 수정폼(DtlRU)으로 남든 결과를 읽을 수 있는 화면
      canVerifyArrival: Boolean(isStudentPageUrl || hasArrivalEditForm || hasStudentDetailView)
    };
  }

  function expandStudentInfoMenu() {
    const child = document.querySelector('#nMenuTreeHome7');
    if (child && isVisible(child)) return { ok: true, alreadyExpanded: true };
    const parent = document.querySelector('#nMenuTreeHome6');
    if (!parent) return { ok: false, message: '유학생정보관리 메뉴(#nMenuTreeHome6)를 찾지 못했습니다.' };
    if (parent.getAttribute('aria-expanded') === 'true' && child) return { ok: true, alreadyExpanded: true };
    if (!clickTarget(parent)) return { ok: false, message: '유학생정보관리 메뉴를 클릭하지 못했습니다.' };
    return { ok: true };
  }

  function clickStudentBasicMenu() {
    const child = document.querySelector('#nMenuTreeHome7');
    if (!child) return { ok: false, message: '유학생기본정보 메뉴(#nMenuTreeHome7)를 찾지 못했습니다.' };
    if (!scheduleClick(child)) return { ok: false, message: '유학생기본정보 메뉴를 클릭하지 못했습니다.' };
    return { ok: true };
  }

  function prepareArrivalSearch(payload) {
    const nameInput = document.querySelector('#sEkNm');
    const birthInput = document.querySelector('#sBirthYmd');
    const similar = document.querySelector('#sLikeYn');
    if (!nameInput || !birthInput || !similar) return { ok: false, message: '이름·생년월일·유사 검색 요소를 찾지 못했습니다.' };
    const searchName = normalizeFimsName(payload.name);
    const birthDate = formatDate(payload.birthDate);
    if (!searchName || !/^\d{4}\.\d{2}\.\d{2}$/.test(birthDate)) return { ok: false, message: '검색할 성명 또는 생년월일 형식이 올바르지 않습니다.' };
    setNativeValue(nameInput, searchName);
    setNativeValue(birthInput, birthDate);
    setChecked(similar, true);
    const nameMatches = sameFimsName(nameInput.value, searchName);
    const birthMatches = digits(birthInput.value) === digits(birthDate);
    const similarMatches = similar.checked === true;
    if (!nameMatches || !birthMatches || !similarMatches) {
      return {
        ok: false,
        message: `FIMS 검색 조건 입력값을 재검증하지 못했습니다. (성명 ${nameMatches ? 'OK' : '실패'} / 생년월일 ${birthMatches ? 'OK' : '실패'} / 유사체크 ${similarMatches ? 'OK' : '실패'})`
      };
    }
    const searchButton = findSearchButton();
    if (!searchButton || !scheduleClick(searchButton)) return { ok: false, message: '조회 버튼을 찾지 못했습니다.' };
    return { ok: true, data: { name: searchName, birthDate, similarChecked: true, documentToken: DOCUMENT_TOKEN } };
  }

  function clickArrivalEdit() {
    const captured = document.querySelector('a[title="수정"], a[onclick*="fncUpdate"]');
    const target = captured && isVisible(captured) ? captured : findClickableByExactText('수정');
    if (!target || !scheduleClick(target)) return { ok: false, message: '수정 버튼을 찾지 못했습니다.' };
    return { ok: true };
  }

  function fillArrivalEdit(payload) {
    const identity = readDetailData(payload);
    if (!identity.nameMatches || !identity.birthDateMatches) return { ok: false, message: '수정화면의 성명·생년월일이 엑셀 대상과 일치하지 않습니다.' };
    const studentNo = document.querySelector('#scholNo');
    const arrivalSelect = document.querySelector('#entrYN');
    const admissionDate = document.querySelector('#admsnYmd');
    if (!studentNo || !arrivalSelect || !admissionDate) return { ok: false, message: '수정화면의 학번·입국일자·입학(복학)일자 요소를 찾지 못했습니다.' };
    const expectedStudentNo = digits(payload.studentNo);
    const expectedAdmissionDate = formatDate(payload.admissionDate);
    setNativeValue(studentNo, expectedStudentNo);
    setNativeValue(arrivalSelect, 'N');
    setNativeValue(admissionDate, expectedAdmissionDate);
    const selectedText = normalizeText(arrivalSelect.options[arrivalSelect.selectedIndex]?.text || '');
    if (digits(studentNo.value) !== expectedStudentNo) return { ok: false, message: '학번 입력값이 FIMS 화면에 유지되지 않았습니다.' };
    if (arrivalSelect.value !== 'N' || selectedText !== '입국') return { ok: false, message: `입국 선택값을 확인하지 못했습니다: ${arrivalSelect.value}/${selectedText}` };
    if (digits(admissionDate.value) !== digits(expectedAdmissionDate)) return { ok: false, message: '입학(복학)일자 입력값이 FIMS 화면에 유지되지 않았습니다.' };
    return {
      ok: true,
      data: {
        studentNo: studentNo.value,
        arrivalCode: arrivalSelect.value,
        arrivalText: selectedText,
        admissionDate: admissionDate.value,
        immigrationArrivalDate: normalizeText(document.querySelector('#eYmd')?.value || '')
      }
    };
  }

  function saveArrivalEdit() {
    const target = findSaveButton();
    if (!target || !scheduleClick(target)) return { ok: false, message: '저장 버튼을 찾지 못했습니다.' };
    return { ok: true };
  }

  function respond(action, payload) {
    switch (action) {
      case 'INSPECT': return { ok: true, data: inspect() };
      case 'EXPAND_STUDENT_INFO_MENU': return expandStudentInfoMenu();
      case 'CLICK_STUDENT_BASIC_MENU': return clickStudentBasicMenu();
      case 'PREPARE_ARRIVAL_SEARCH': return prepareArrivalSearch(payload);
      case 'READ_ARRIVAL_SEARCH_RESULT': return { ok: true, data: readArrivalSearchResult(payload) };
      case 'OPEN_ARRIVAL_DETAIL': return openArrivalDetail(payload);
      case 'READ_DETAIL_IDENTITY':
      case 'READ_ARRIVAL_VERIFICATION': return { ok: true, data: readDetailData(payload) };
      case 'CLICK_ARRIVAL_EDIT': return clickArrivalEdit();
      case 'FILL_ARRIVAL_EDIT': return fillArrivalEdit(payload);
      case 'SAVE_ARRIVAL_EDIT': return saveArrivalEdit();
      default: return { ok: false, message: `지원하지 않는 동작: ${action}` };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'FIMS_ARRIVAL_RPA_ACTION') return;
    try { sendResponse(respond(message.action, message.payload || {})); }
    catch (error) { sendResponse({ ok: false, message: error?.message || String(error) }); }
  });

  globalThis.__FIMS_ARRIVAL_RPA_TEST_HOOKS__ = {
    normalizeFimsName,
    sameFimsName,
    resultNameMatches,
    resolveDetailCandidate,
    formatDate,
    prepareArrivalSearch,
    readArrivalSearchResult,
    openArrivalDetail,
    readDetailData,
    fillArrivalEdit,
    inspect
  };
})();
