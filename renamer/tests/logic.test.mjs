import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertDate,
  isValidDate,
  computeDigits,
  buildSequenceName,
  sortFiles,
} from "../src/rename-logic.js";

test("convertDate: YYMMDD_ → YYYYMMDD_ (F-10)", () => {
  assert.deepEqual(convertDate("260520_삼청동.jpg"), {
    status: "ok",
    newName: "20260520_삼청동.jpg",
  });
});

test("convertDate: 확장자 없는 파일도 처리", () => {
  assert.deepEqual(convertDate("260701_강남"), {
    status: "ok",
    newName: "20260701_강남",
  });
});

test("convertDate: 세기 접두어 19 선택 (F-14)", () => {
  assert.deepEqual(convertDate("991231_송년", "19"), {
    status: "ok",
    newName: "19991231_송년",
  });
});

test("convertDate: 이미 YYYYMMDD_ 이면 제외 (F-12)", () => {
  assert.equal(convertDate("20260520_삼청동.jpg").status, "already");
});

test("convertDate: 존재하지 않는 날짜는 변환 불가 (F-11, 260231)", () => {
  assert.equal(convertDate("260231_xx.jpg").status, "invalid");
});

test("convertDate: 윤년 판정 (240229 유효 / 260229 무효)", () => {
  assert.equal(convertDate("240229_a.jpg").status, "ok"); // 2024 윤년
  assert.equal(convertDate("260229_a.jpg").status, "invalid"); // 2026 평년
});

test("convertDate: 월 범위 밖은 무효 (13월)", () => {
  assert.equal(convertDate("261301_a.jpg").status, "invalid");
});

test("convertDate: 날짜 패턴 없으면 대상 아님", () => {
  assert.equal(convertDate("IMG_2031.jpg").status, "nomatch");
});

test("isValidDate", () => {
  assert.ok(isValidDate(2026, 5, 20));
  assert.ok(!isValidDate(2026, 2, 31));
  assert.ok(!isValidDate(2026, 0, 10));
  assert.ok(isValidDate(2024, 2, 29));
});

test("computeDigits: 자동 자릿수 (F-25)", () => {
  assert.equal(computeDigits(24, 1, "auto"), 2);
  assert.equal(computeDigits(100, 1, "auto"), 3); // 100개 이상 → 3자리
  assert.equal(computeDigits(9, 1, "auto"), 2); // 최소 2자리
  assert.equal(computeDigits(5, 1, "manual", 4), 4);
});

test("buildSequenceName: PRD 예시 재현 (맨 앞)", () => {
  const file = { stem: "IMG_2031", ext: "jpg" };
  const name = buildSequenceName(file, 1, 2, {
    fixed: "_강남촬영",
    position: "prefix",
    separator: "_",
  });
  assert.equal(name, "01_IMG_2031_강남촬영.jpg");
});

test("buildSequenceName: 맨 뒤 위치", () => {
  const file = { stem: "IMG_2031", ext: "jpg" };
  const name = buildSequenceName(file, 2, 2, {
    fixed: "_강남촬영",
    position: "suffix",
    separator: "_",
  });
  assert.equal(name, "IMG_2031_강남촬영_02.jpg");
});

test("buildSequenceName: 원본 대체 (F-28)", () => {
  const file = { stem: "IMG_2031", ext: "jpg" };
  const name = buildSequenceName(file, 3, 2, {
    fixed: "_강남촬영",
    position: "prefix",
    separator: "_",
    replaceOriginal: true,
  });
  assert.equal(name, "03_강남촬영.jpg");
});

test("buildSequenceName: 고정 문자 없이 순번만", () => {
  const file = { stem: "photo", ext: "png" };
  const name = buildSequenceName(file, 7, 3, { position: "prefix", separator: "_" });
  assert.equal(name, "007_photo.png");
});

test("sortFiles: 생성일 최신순 → 최신이 먼저", () => {
  const files = [
    { name: "a", created: 100, modified: 100 },
    { name: "b", created: 300, modified: 300 },
    { name: "c", created: 200, modified: 200 },
  ];
  const sorted = sortFiles(files, "created", "desc");
  assert.deepEqual(sorted.map((f) => f.name), ["b", "c", "a"]);
});

test("sortFiles: 생성일 동일 시 파일명 사전순 2차 정렬 (엣지케이스)", () => {
  const files = [
    { name: "z.jpg", created: 100, modified: 100 },
    { name: "a.jpg", created: 100, modified: 100 },
  ];
  const sorted = sortFiles(files, "created", "asc");
  assert.deepEqual(sorted.map((f) => f.name), ["a.jpg", "z.jpg"]);
});
