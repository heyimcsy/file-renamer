// Renamer — 맥용 파일명 일괄 변경 도구 (백엔드)
//
// 프론트엔드(JS)가 실제 리네이밍 규칙(날짜 변환/순번)을 계산하고,
// 이 백엔드는 파일 시스템 접근만 담당한다.
//   - scan_paths : 드롭/선택된 경로를 펼쳐 파일 목록 + 메타데이터(생성일 등) 반환
//   - apply_rename: 2단계(임시명 경유) 리네임으로 순서 뒤섞임/충돌을 안전하게 처리
//   - undo_last  : 마지막 적용 1회를 원래 이름으로 복원
//   - has_undo   : 되돌릴 내역이 있는지

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// 데이터 구조
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct FileEntry {
    path: String,
    name: String,
    stem: String,
    ext: String,
    parent: String,
    created: Option<u64>,  // epoch millis
    modified: Option<u64>, // epoch millis
}

#[derive(Serialize)]
struct ScanResult {
    files: Vec<FileEntry>,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct RenameOp {
    path: String,     // 현재 절대 경로
    new_name: String, // 새 파일명(디렉터리 제외)
}

#[derive(Serialize)]
struct ItemResult {
    old_path: String,
    new_path: String,
    success: bool,
    skipped: bool,
    error: Option<String>,
}

#[derive(Serialize)]
struct ApplyResult {
    results: Vec<ItemResult>,
    success_count: usize,
    fail_count: usize,
    skip_count: usize,
}

#[derive(Serialize, Deserialize)]
struct UndoPair {
    from: String, // 원래 이름(적용 전)
    to: String,   // 적용 후 실제 이름
}

#[derive(Serialize, Deserialize)]
struct UndoLog {
    timestamp: u64,
    renames: Vec<UndoPair>,
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

fn to_millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// 목록에서 자동 제외할 파일/폴더인지.
/// - macOS/유닉스: 점으로 시작하는 숨김 파일(.DS_Store 등)
/// - Windows: 정크 파일(Thumbs.db, desktop.ini)
fn is_hidden_name(name: &OsStr) -> bool {
    match name.to_str() {
        Some(s) => {
            s.starts_with('.')
                || s.eq_ignore_ascii_case("Thumbs.db")
                || s.eq_ignore_ascii_case("desktop.ini")
        }
        None => false,
    }
}

/// 파일명을 (본문, 확장자) 로 나눈다. 확장자가 없으면 ("이름", "").
/// 점으로 시작하는 dotfile 은 확장자로 취급하지 않는다.
fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(idx) if idx > 0 => (name[..idx].to_string(), name[idx + 1..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

/// 대상 경로가 이미 존재하면 `이름 (1).ext`, `이름 (2).ext` … 로 비어있는 이름을 찾는다.
fn unique_suffix(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (stem, ext) = split_name(&name);
    let mut n = 1u32;
    loop {
        let candidate = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let cp = parent.join(candidate);
        if !cp.exists() {
            return cp;
        }
        n += 1;
    }
}

struct RenameOutcome {
    original: PathBuf,
    requested: PathBuf,
    actual: Option<PathBuf>,
    success: bool,
    skipped: bool,
    error: Option<String>,
}

/// 2단계 리네임.
/// 1) 모든 원본을 같은 폴더의 숨김 임시명으로 옮긴다 (서로의 이름과 충돌하지 않도록).
/// 2) 임시명을 최종 이름으로 옮긴다. 최종 이름이 배치 밖의 기존 파일과 겹치면
///    conflict_mode 에 따라 건너뛰거나("skip") `(1)` 접미어("suffix")를 붙인다.
fn two_phase_rename(pairs: &[(PathBuf, PathBuf)], conflict_mode: &str) -> Vec<RenameOutcome> {
    let pid = std::process::id();
    let mut outcomes: Vec<RenameOutcome> = Vec::new();
    let mut phase2: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new(); // (temp, original, requested)

    for (i, (src, dst)) in pairs.iter().enumerate() {
        let parent = src
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let temp = parent.join(format!(".renamer-tmp-{pid}-{i}"));
        match fs::rename(src, &temp) {
            Ok(_) => phase2.push((temp, src.clone(), dst.clone())),
            Err(e) => outcomes.push(RenameOutcome {
                original: src.clone(),
                requested: dst.clone(),
                actual: None,
                success: false,
                skipped: false,
                error: Some(e.to_string()),
            }),
        }
    }

    for (temp, original, requested) in phase2 {
        let mut target = requested.clone();
        if target.exists() {
            if conflict_mode == "suffix" {
                target = unique_suffix(&target);
            } else {
                // skip: 원래 위치로 되돌린다.
                let _ = fs::rename(&temp, &original);
                outcomes.push(RenameOutcome {
                    original,
                    requested,
                    actual: None,
                    success: false,
                    skipped: true,
                    error: Some("대상에 같은 이름의 파일이 이미 존재합니다.".into()),
                });
                continue;
            }
        }
        match fs::rename(&temp, &target) {
            Ok(_) => outcomes.push(RenameOutcome {
                original,
                requested,
                actual: Some(target),
                success: true,
                skipped: false,
                error: None,
            }),
            Err(e) => {
                let _ = fs::rename(&temp, &original); // 실패 시 복구 시도
                outcomes.push(RenameOutcome {
                    original,
                    requested,
                    actual: None,
                    success: false,
                    skipped: false,
                    error: Some(e.to_string()),
                });
            }
        }
    }

    outcomes
}

fn summarize(outcomes: Vec<RenameOutcome>) -> ApplyResult {
    let mut results = Vec::with_capacity(outcomes.len());
    let (mut success_count, mut skip_count) = (0usize, 0usize);
    for o in outcomes {
        if o.success {
            success_count += 1;
        } else if o.skipped {
            skip_count += 1;
        }
        let new_path = o
            .actual
            .clone()
            .unwrap_or_else(|| o.requested.clone())
            .to_string_lossy()
            .to_string();
        results.push(ItemResult {
            old_path: o.original.to_string_lossy().to_string(),
            new_path,
            success: o.success,
            skipped: o.skipped,
            error: o.error,
        });
    }
    let fail_count = results.len() - success_count - skip_count;
    ApplyResult {
        results,
        success_count,
        fail_count,
        skip_count,
    }
}

fn undo_log_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾을 수 없습니다: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("last_undo.json"))
}

// ---------------------------------------------------------------------------
// Tauri 커맨드
// ---------------------------------------------------------------------------

#[tauri::command]
fn scan_paths(paths: Vec<String>, include_subfolders: bool) -> ScanResult {
    let mut files: Vec<FileEntry> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let add_file = |path: &Path, files: &mut Vec<FileEntry>, seen: &mut HashSet<String>| {
        let abs = path.to_string_lossy().to_string();
        if !seen.insert(abs.clone()) {
            return;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let (stem, ext) = split_name(&name);
        let parent = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let (created, modified) = match fs::metadata(path) {
            Ok(m) => (
                m.created().ok().and_then(to_millis),
                m.modified().ok().and_then(to_millis),
            ),
            Err(_) => (None, None),
        };
        files.push(FileEntry {
            path: abs,
            name,
            stem,
            ext,
            parent,
            created,
            modified,
        });
    };

    for p in paths {
        let path = PathBuf::from(&p);
        if path.is_dir() {
            let max_depth = if include_subfolders { usize::MAX } else { 1 };
            let walker = WalkDir::new(&path)
                .min_depth(1)
                .max_depth(max_depth)
                .into_iter()
                // 숨김 폴더/파일은 통째로 건너뛴다 (하위로 내려가지 않음).
                .filter_entry(|e| e.depth() == 0 || !is_hidden_name(e.file_name()));
            for entry in walker {
                match entry {
                    Ok(e) => {
                        if e.file_type().is_file() {
                            add_file(e.path(), &mut files, &mut seen);
                        }
                    }
                    Err(err) => warnings.push(err.to_string()),
                }
            }
        } else if path.is_file() {
            if !is_hidden_name(path.file_name().unwrap_or_default()) {
                add_file(&path, &mut files, &mut seen);
            }
        } else {
            warnings.push(format!("찾을 수 없음: {p}"));
        }
    }

    ScanResult { files, warnings }
}

#[tauri::command]
fn apply_rename(
    app: tauri::AppHandle,
    operations: Vec<RenameOp>,
    conflict_mode: String,
) -> Result<ApplyResult, String> {
    let pairs: Vec<(PathBuf, PathBuf)> = operations
        .iter()
        .filter_map(|op| {
            let src = PathBuf::from(&op.path);
            let parent = src.parent()?.to_path_buf();
            Some((src, parent.join(&op.new_name)))
        })
        .collect();

    let outcomes = two_phase_rename(&pairs, &conflict_mode);

    // 되돌리기 로그 기록 (성공한 항목만).
    let renames: Vec<UndoPair> = outcomes
        .iter()
        .filter(|o| o.success)
        .map(|o| UndoPair {
            from: o.original.to_string_lossy().to_string(),
            to: o
                .actual
                .clone()
                .unwrap_or_else(|| o.requested.clone())
                .to_string_lossy()
                .to_string(),
        })
        .collect();

    if !renames.is_empty() {
        let log = UndoLog {
            timestamp: to_millis(SystemTime::now()).unwrap_or(0),
            renames,
        };
        if let Ok(path) = undo_log_path(&app) {
            if let Ok(json) = serde_json::to_string_pretty(&log) {
                let _ = fs::write(path, json);
            }
        }
    }

    Ok(summarize(outcomes))
}

#[tauri::command]
fn undo_last(app: tauri::AppHandle) -> Result<ApplyResult, String> {
    let log_path = undo_log_path(&app)?;
    if !log_path.exists() {
        return Err("되돌릴 작업이 없습니다.".into());
    }
    let data = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let log: UndoLog = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    // 적용 후 이름(to) → 원래 이름(from) 으로 되돌린다.
    let pairs: Vec<(PathBuf, PathBuf)> = log
        .renames
        .iter()
        .map(|r| (PathBuf::from(&r.to), PathBuf::from(&r.from)))
        .collect();

    // 복원 시에는 사용자가 만들어 둔 파일을 덮어쓰지 않도록 skip.
    let outcomes = two_phase_rename(&pairs, "skip");
    let _ = fs::remove_file(&log_path); // 단일 단계 undo: 사용 후 로그 제거
    Ok(summarize(outcomes))
}

#[tauri::command]
fn has_undo(app: tauri::AppHandle) -> bool {
    undo_log_path(&app).map(|p| p.exists()).unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_paths,
            apply_rename,
            undo_last,
            has_undo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// 테스트
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("renamer-test-{}-{}-{}", tag, std::process::id(), nanos));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, contents).unwrap();
        p
    }

    #[test]
    fn split_name_handles_extensions_and_dotfiles() {
        assert_eq!(split_name("260520_삼청동.jpg"), ("260520_삼청동".into(), "jpg".into()));
        assert_eq!(split_name("no_extension"), ("no_extension".into(), "".into()));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar".into(), "gz".into()));
        assert_eq!(split_name(".DS_Store"), (".DS_Store".into(), "".into()));
    }

    #[test]
    fn hidden_files_detected() {
        assert!(is_hidden_name(OsStr::new(".DS_Store")));
        assert!(is_hidden_name(OsStr::new("Thumbs.db"))); // Windows 정크
        assert!(is_hidden_name(OsStr::new("desktop.ini")));
        assert!(!is_hidden_name(OsStr::new("photo.jpg")));
    }

    #[test]
    fn two_phase_handles_swap() {
        let dir = temp_dir("swap");
        write(&dir, "a.txt", "AAA");
        write(&dir, "b.txt", "BBB");
        let pairs = vec![
            (dir.join("a.txt"), dir.join("b.txt")),
            (dir.join("b.txt"), dir.join("a.txt")),
        ];
        let out = two_phase_rename(&pairs, "skip");
        assert!(out.iter().all(|o| o.success), "swap should fully succeed");
        // 내용이 서로 바뀌었는지 확인
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "BBB");
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "AAA");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflict_skip_leaves_existing_untouched() {
        let dir = temp_dir("skip");
        write(&dir, "a.txt", "AAA");
        write(&dir, "c.txt", "CCC"); // 배치에 없는 기존 파일
        let pairs = vec![(dir.join("a.txt"), dir.join("c.txt"))];
        let out = two_phase_rename(&pairs, "skip");
        assert!(out[0].skipped, "should skip on existing target");
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "AAA", "source restored");
        assert_eq!(fs::read_to_string(dir.join("c.txt")).unwrap(), "CCC", "existing untouched");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflict_suffix_creates_numbered_copy() {
        let dir = temp_dir("suffix");
        write(&dir, "a.txt", "AAA");
        write(&dir, "c.txt", "CCC");
        let pairs = vec![(dir.join("a.txt"), dir.join("c.txt"))];
        let out = two_phase_rename(&pairs, "suffix");
        assert!(out[0].success);
        assert_eq!(out[0].actual.as_ref().unwrap(), &dir.join("c (1).txt"));
        assert_eq!(fs::read_to_string(dir.join("c (1).txt")).unwrap(), "AAA");
        assert_eq!(fs::read_to_string(dir.join("c.txt")).unwrap(), "CCC");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scan_filters_hidden_and_reads_metadata() {
        let dir = temp_dir("scan");
        write(&dir, "photo.jpg", "x");
        write(&dir, ".DS_Store", "x");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write(&sub, "nested.png", "y");

        // 하위 폴더 미포함
        let res = scan_paths(vec![dir.to_string_lossy().to_string()], false);
        let names: Vec<&str> = res.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"photo.jpg"));
        assert!(!names.contains(&".DS_Store"), "hidden filtered");
        assert!(!names.contains(&"nested.png"), "subfolder excluded when off");

        // 하위 폴더 포함
        let res2 = scan_paths(vec![dir.to_string_lossy().to_string()], true);
        let names2: Vec<&str> = res2.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names2.contains(&"nested.png"), "subfolder included when on");

        // 메타데이터(수정일)는 읽혀야 한다
        let photo = res.files.iter().find(|f| f.name == "photo.jpg").unwrap();
        assert!(photo.modified.is_some());
        assert_eq!(photo.ext, "jpg");
        fs::remove_dir_all(&dir).ok();
    }
}
