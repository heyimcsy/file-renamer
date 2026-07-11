// 순수 함수 모음 — Tauri/DOM 의존성 없음. Node 테스트에서 그대로 import 가능.

/** 윤년 여부 */
export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 실제 달력상 유효한 날짜인지 (월 1–12, 일은 해당 월의 실제 일수 기준). */
export function isValidDate(y, m, d) {
  if (m < 1 || m > 12) return false;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d >= 1 && d <= dim[m - 1];
}

/**
 * 모드 1 — 날짜 포맷 변환.
 * 파일명 맨 앞의 `YYMMDD_` 를 `YYYYMMDD_` 로 바꾼다.
 * @returns {{status:'ok', newName:string} | {status:'already'|'invalid'|'nomatch'}}
 *   - already : 이미 YYYYMMDD_ 형식 → 변경 대상 아님
 *   - invalid : YYMMDD_ 패턴이지만 존재하지 않는 날짜 → 변환 불가
 *   - nomatch : 날짜 패턴이 없음 → 대상 아님
 */
export function convertDate(name, century = "20") {
  if (/^\d{8}_/.test(name)) return { status: "already" };
  const m = name.match(/^(\d{2})(\d{2})(\d{2})_(.*)$/s);
  if (!m) return { status: "nomatch" };
  const [, yy, mm, dd, rest] = m;
  const year = parseInt(century + yy, 10);
  if (!isValidDate(year, parseInt(mm, 10), parseInt(dd, 10))) {
    return { status: "invalid" };
  }
  return { status: "ok", newName: `${century}${yy}${mm}${dd}_${rest}` };
}

/** 순번 자릿수. 자동이면 최대 번호의 자릿수(최소 2), 100개 이상이면 3자리가 된다. */
export function computeDigits(count, start, mode, manual) {
  if (mode === "manual") return Math.max(1, manual | 0);
  const max = start + count - 1;
  return Math.max(2, String(Math.max(max, 1)).length);
}

/**
 * 모드 2 — 순번 붙이기용 새 파일명 생성.
 * 예) stem="IMG_2031", fixed="_강남촬영", position="prefix", sep="_", num=1
 *     → "01_IMG_2031_강남촬영.jpg"
 */
export function buildSequenceName(file, number, digits, opts) {
  const {
    fixed = "",
    position = "prefix",
    separator = "_",
    replaceOriginal = false,
  } = opts;
  const { stem, ext } = file;
  const numStr = String(number).padStart(digits, "0");

  // 순번을 제외한 본문: 원본 유지 시 "원본+고정문자", 대체 시 "고정문자"만.
  const content = replaceOriginal ? fixed : stem + fixed;

  let base;
  if (!content) {
    base = numStr;
  } else if (position === "prefix") {
    const sep = content.startsWith(separator) ? "" : separator;
    base = numStr + sep + content;
  } else {
    const sep = content.endsWith(separator) ? "" : separator;
    base = content + sep + numStr;
  }

  return ext ? `${base}.${ext}` : base;
}

/**
 * 순번 모드 정렬. 생성일/수정일/파일명 기준, 오름/내림차순.
 * 생성일·수정일이 같으면 파일명 사전순(2차 기준). 값이 없으면 다른 시각으로 대체.
 */
export function sortFiles(files, field, dir) {
  const arr = [...files];
  const factor = dir === "desc" ? -1 : 1;
  arr.sort((a, b) => {
    let cmp;
    if (field === "name") {
      cmp = a.name.localeCompare(b.name, "ko");
    } else {
      const av = (field === "created" ? a.created : a.modified) ?? a.modified ?? a.created ?? 0;
      const bv = (field === "created" ? b.created : b.modified) ?? b.modified ?? b.created ?? 0;
      cmp = av - bv;
      if (cmp === 0) cmp = a.name.localeCompare(b.name, "ko");
    }
    return factor * cmp;
  });
  return arr;
}
