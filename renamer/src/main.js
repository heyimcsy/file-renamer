import {
  convertDate,
  buildSequenceName,
  computeDigits,
  sortFiles,
} from "./rename-logic.js";

const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const dialog = window.__TAURI__?.dialog;

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
const state = {
  roots: [], // 드롭/선택된 최상위 경로(파일 또는 폴더)
  files: [], // scan 결과 전체
  removed: new Set(), // 사용자가 목록에서 제외한 경로
  warnings: [],
  mode: "date",
  includeSub: false,
  onlyChanges: false,
  conflictMode: "skip",
  // 날짜 모드
  century: "20",
  // 순번 모드
  sortField: "created",
  sortDir: "desc",
  fixed: "",
  position: "prefix",
  startNumber: 1,
  digitsMode: "auto",
  digitsManual: 2,
  separator: "_",
  replaceOriginal: false,
};

const el = (id) => document.getElementById(id);
const visibleFiles = () => state.files.filter((f) => !state.removed.has(f.path));
// 경로에서 파일명만 (macOS `/`·Windows `\` 모두 대응)
const baseName = (p) => p.split(/[\\/]/).pop();

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// 미리보기 계산
// ---------------------------------------------------------------------------
// 각 row: { file, oldName, newName, status }
// status: change | nochange | already | invalid | nomatch | conflict
function computeRows() {
  const files = visibleFiles();
  let rows;

  if (state.mode === "date") {
    rows = files.map((file) => {
      const r = convertDate(file.name, state.century);
      if (r.status === "ok") {
        const status = r.newName === file.name ? "nochange" : "change";
        return { file, oldName: file.name, newName: r.newName, status };
      }
      const labels = {
        already: "이미 변환됨",
        invalid: "변환 불가 (날짜)",
        nomatch: "대상 아님",
      };
      return { file, oldName: file.name, newName: labels[r.status], status: r.status };
    });
    // 원래 목록 순서 유지
  } else {
    const sorted = sortFiles(files, state.sortField, state.sortDir);
    const start = Number.isFinite(state.startNumber) ? state.startNumber : 1;
    const digits = computeDigits(sorted.length, start, state.digitsMode, state.digitsManual);
    const opts = {
      fixed: state.fixed,
      position: state.position,
      separator: state.separator,
      replaceOriginal: state.replaceOriginal,
    };
    rows = sorted.map((file, i) => {
      const newName = buildSequenceName(file, start + i, digits, opts);
      const status = newName === file.name ? "nochange" : "change";
      return { file, oldName: file.name, newName, status };
    });
  }

  detectConflicts(rows);
  return rows;
}

// 같은 폴더에서 결과 파일명이 겹치면 충돌(F-31). 변하지 않는 파일의 현재 이름도 점유로 계산.
function detectConflicts(rows) {
  const occ = new Map();
  rows.forEach((r, idx) => {
    const finalName = r.status === "change" ? r.newName : r.oldName;
    // (parent, finalName) 쌍으로 폴더별 결과 이름 충돌을 감지한다.
    const key = JSON.stringify([r.file.parent, finalName]);
    if (!occ.has(key)) occ.set(key, []);
    occ.get(key).push(idx);
  });
  occ.forEach((list) => {
    if (list.length > 1) {
      list.forEach((idx) => {
        if (rows[idx].status === "change") rows[idx].status = "conflict";
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------
let renderQueued = false;
function refresh() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

const STATUS_BADGE = {
  change: "",
  conflict: "충돌",
  nochange: "변경 없음",
  already: "이미 변환됨",
  invalid: "변환 불가",
  nomatch: "대상 아님",
};

function render() {
  const rows = computeRows();
  const totalVisible = rows.length;
  const changeCount = rows.filter((r) => r.status === "change").length;
  const conflictCount = rows.filter((r) => r.status === "conflict").length;

  // 경고
  const warnBox = el("warnings");
  if (state.warnings.length) {
    warnBox.hidden = false;
    warnBox.textContent = "⚠︎ " + state.warnings.join(" · ");
  } else {
    warnBox.hidden = true;
  }

  el("btn-clear").hidden = state.files.length === 0;

  // 카운트 배지
  const badge = el("count-badge");
  if (totalVisible === 0) {
    badge.textContent = "미리보기";
  } else {
    let t = `미리보기 (${totalVisible}개) · 변경 ${changeCount}`;
    if (conflictCount) t += ` · 충돌 ${conflictCount}`;
    badge.textContent = t;
  }

  // 목록
  const list = el("preview-list");
  const display = state.onlyChanges
    ? rows.filter((r) => r.status === "change" || r.status === "conflict")
    : rows;

  if (state.files.length === 0) {
    list.innerHTML = `<div class="empty">파일을 추가하면 <b>변경 전 → 변경 후</b> 목록이 여기에 표시됩니다.</div>`;
  } else if (display.length === 0) {
    list.innerHTML = `<div class="empty">표시할 항목이 없습니다.</div>`;
  } else {
    const html = display
      .map((r) => {
        const badgeText = STATUS_BADGE[r.status];
        const badgeHtml = badgeText
          ? `<span class="badge b-${r.status}">${badgeText}</span>`
          : "";
        const newClass = r.status === "change" || r.status === "conflict" ? "new" : "new muted";
        return `<div class="prow s-${r.status}">
          <button class="remove" data-path="${escapeHtml(r.file.path)}" title="목록에서 제외">×</button>
          <span class="old" title="${escapeHtml(r.file.path)}">${escapeHtml(r.oldName)}</span>
          <span class="arrow">→</span>
          <span class="${newClass}">${escapeHtml(r.newName)}</span>
          ${badgeHtml}
        </div>`;
      })
      .join("");
    list.innerHTML = html;
  }

  // 적용 버튼: 변경할 게 있고 충돌이 없을 때만
  const applyBtn = el("btn-apply");
  applyBtn.disabled = !(changeCount > 0 && conflictCount === 0);
  applyBtn.title = conflictCount > 0 ? "이름 충돌을 먼저 해결하세요" : "";
}

// ---------------------------------------------------------------------------
// 파일 입력
// ---------------------------------------------------------------------------
async function addPaths(paths) {
  const fresh = paths.filter((p) => p && !state.roots.includes(p));
  if (fresh.length === 0) return;
  state.roots.push(...fresh);
  await rescan();
}

async function rescan() {
  if (!invoke || state.roots.length === 0) {
    state.files = [];
    refresh();
    return;
  }
  try {
    const res = await invoke("scan_paths", {
      paths: state.roots,
      includeSubfolders: state.includeSub,
    });
    state.files = res.files || [];
    state.warnings = res.warnings || [];
  } catch (e) {
    toast("파일을 읽는 중 오류: " + e);
  }
  refresh();
}

function clearAll() {
  state.roots = [];
  state.files = [];
  state.removed.clear();
  state.warnings = [];
  el("summary").textContent = "";
  refresh();
}

// ---------------------------------------------------------------------------
// 적용 / 되돌리기
// ---------------------------------------------------------------------------
async function apply() {
  if (!invoke) return;
  const rows = computeRows().filter((r) => r.status === "change");
  if (rows.length === 0) return;
  const operations = rows.map((r) => ({ path: r.file.path, new_name: r.newName }));

  el("btn-apply").disabled = true;
  try {
    const res = await invoke("apply_rename", {
      operations,
      conflictMode: state.conflictMode,
    });
    showApplyResult(res);
    // 성공한 항목의 경로를 roots 에 반영한 뒤 다시 스캔해 최신 이름으로 갱신.
    const map = new Map(res.results.filter((x) => x.success).map((x) => [x.old_path, x.new_path]));
    state.roots = state.roots.map((p) => map.get(p) || p);
    await rescan();
    await refreshUndoButton();
  } catch (e) {
    toast("적용 중 오류: " + e);
    refresh();
  }
}

async function undo() {
  if (!invoke) return;
  el("btn-undo").disabled = true;
  try {
    const res = await invoke("undo_last");
    const map = new Map(res.results.filter((x) => x.success).map((x) => [x.old_path, x.new_path]));
    state.roots = state.roots.map((p) => map.get(p) || p);
    el("summary").textContent =
      `되돌리기 완료 — 복원 ${res.success_count}건` +
      (res.skip_count ? ` · 건너뜀 ${res.skip_count}` : "") +
      (res.fail_count ? ` · 실패 ${res.fail_count}` : "");
    await rescan();
  } catch (e) {
    toast(String(e));
  }
  await refreshUndoButton();
}

function showApplyResult(res) {
  let msg = `적용 완료 — 성공 ${res.success_count}건`;
  if (res.skip_count) msg += ` · 건너뜀 ${res.skip_count}`;
  if (res.fail_count) msg += ` · 실패 ${res.fail_count}`;
  el("summary").textContent = msg;

  const problems = res.results.filter((r) => !r.success);
  if (problems.length) {
    const detail = problems
      .slice(0, 5)
      .map((p) => `• ${baseName(p.old_path)}: ${p.error || (p.skipped ? "건너뜀" : "실패")}`)
      .join("\n");
    toast(detail + (problems.length > 5 ? `\n… 외 ${problems.length - 5}건` : ""), 6000);
  } else {
    toast(`✓ ${res.success_count}개 파일 이름을 변경했습니다.`);
  }
}

async function refreshUndoButton() {
  if (!invoke) return;
  try {
    const has = await invoke("has_undo");
    el("btn-undo").disabled = !has;
  } catch {
    el("btn-undo").disabled = true;
  }
}

// ---------------------------------------------------------------------------
// 토스트
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(text, ms = 3000) {
  const t = el("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------------------
// 이벤트 배선
// ---------------------------------------------------------------------------
function wire() {
  // 모드
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.mode = e.target.value;
      el("panel-date").hidden = state.mode !== "date";
      el("panel-sequence").hidden = state.mode !== "sequence";
      refresh();
    })
  );

  // 하위 폴더 포함 → 재스캔
  el("include-sub").addEventListener("change", (e) => {
    state.includeSub = e.target.checked;
    rescan();
  });

  el("only-changes").addEventListener("change", (e) => {
    state.onlyChanges = e.target.checked;
    refresh();
  });

  el("conflict-mode").addEventListener("change", (e) => {
    state.conflictMode = e.target.value;
  });

  // 날짜 모드
  el("century").addEventListener("change", (e) => {
    state.century = e.target.value;
    refresh();
  });

  // 순번 모드 컨트롤
  const bind = (id, key, transform = (v) => v) =>
    el(id).addEventListener("input", (e) => {
      state[key] = transform(e.target.value);
      refresh();
    });
  bind("sort-field", "sortField");
  bind("sort-dir", "sortDir");
  bind("fixed", "fixed");
  bind("separator", "separator");
  bind("start-number", "startNumber", (v) => parseInt(v, 10));
  bind("digits-manual", "digitsManual", (v) => parseInt(v, 10));

  el("digits-mode").addEventListener("change", (e) => {
    state.digitsMode = e.target.value;
    el("digits-manual").hidden = state.digitsMode !== "manual";
    refresh();
  });

  document.querySelectorAll('input[name="position"]').forEach((r) =>
    r.addEventListener("change", (e) => {
      state.position = e.target.value;
      refresh();
    })
  );

  el("replace-original").addEventListener("change", (e) => {
    state.replaceOriginal = e.target.checked;
    refresh();
  });

  // 목록에서 제외 (이벤트 위임)
  el("preview-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".remove");
    if (!btn) return;
    state.removed.add(btn.dataset.path);
    refresh();
  });

  // 버튼
  el("btn-clear").addEventListener("click", clearAll);
  el("btn-apply").addEventListener("click", apply);
  el("btn-undo").addEventListener("click", undo);
  el("btn-folder").addEventListener("click", pickFolder);
  el("btn-files").addEventListener("click", pickFiles);
}

async function pickFolder() {
  if (!dialog?.open) return toast("드래그앤드롭으로 폴더를 추가하세요.");
  const sel = await dialog.open({ directory: true, multiple: false });
  if (sel) await addPaths([sel]);
}

async function pickFiles() {
  if (!dialog?.open) return toast("드래그앤드롭으로 파일을 추가하세요.");
  const sel = await dialog.open({ directory: false, multiple: true });
  if (sel) await addPaths(Array.isArray(sel) ? sel : [sel]);
}

async function wireDragDrop() {
  if (!listen) return;
  const dz = el("dropzone");
  await listen("tauri://drag-enter", () => dz.classList.add("dragover"));
  await listen("tauri://drag-over", () => dz.classList.add("dragover"));
  await listen("tauri://drag-leave", () => dz.classList.remove("dragover"));
  await listen("tauri://drag-drop", (e) => {
    dz.classList.remove("dragover");
    const paths = e.payload?.paths || [];
    if (paths.length) addPaths(paths);
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  wire();
  await wireDragDrop();
  await refreshUndoButton();
  render();
});
