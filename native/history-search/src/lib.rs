use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use napi::{Error, Result, Status};
use napi_derive::napi;
use tantivy::collector::TopDocs;
use tantivy::query::{AllQuery, BooleanQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{
    FAST, Field, IndexRecordOption, STORED, STRING, Schema, TEXT, TantivyDocument, Value,
};
use tantivy::{Index, IndexReader, IndexWriter, Term, doc};

// Bump this whenever the on-disk index layout or the indexed corpus semantics change.
// A directory that carries an OLDER copilot-owned marker is transparently wiped and
// rebuilt (the index is disposable and never authoritative), so incompatible legacy
// indexes self-heal instead of degrading forever. See `assert_identity`.
const FORMAT_MARKER: &str = "copilot-api-history-search-tantivy-v3\n";
const FORMAT_FILE: &str = "FORMAT";
const WRITER_MEMORY_BYTES: usize = 50_000_000;

#[napi(object)]
pub struct SearchHit {
    pub operation_id: String,
    pub created_at: i64,
    pub score: f64,
}

#[napi(object)]
pub struct SearchDocument {
    pub operation_id: String,
    pub operation_kind: String,
    pub created_at: i64,
    pub committed_at: i64,
    pub content: String,
    pub endpoint: Option<String>,
    pub state: Option<String>,
    pub pid: Option<i64>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub request_model: Option<String>,
    pub response_model: Option<String>,
}

#[napi(object)]
pub struct ListSearchRequest {
    pub query: String,
    pub operation_kinds: Vec<String>,
    pub endpoint: Option<String>,
    pub states: Vec<String>,
    pub pid: Option<i64>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub main_agent_only: Option<bool>,
    pub model: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub target_committed_at: i64,
    pub target_operation_ids: Vec<String>,
    pub cursor_started_at: Option<i64>,
    pub cursor_operation_id: Option<String>,
    pub cursor_require_match: Option<bool>,
    pub direction: String,
    pub limit: u32,
}

#[napi(object)]
pub struct ListSearchResult {
    pub operation_ids: Vec<String>,
    pub total: u32,
    pub has_older: bool,
    pub has_newer: bool,
    pub invalid_cursor: bool,
}

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("operation_id", STRING | STORED | FAST);
    builder.add_text_field("operation_kind", STRING | STORED);
    builder.add_text_field("content", TEXT);
    builder.add_u64_field("created_at", STORED | FAST);
    builder.add_u64_field("committed_at", STORED | FAST);
    builder.add_text_field("endpoint", STRING | STORED);
    builder.add_text_field("state", STRING | STORED);
    builder.add_i64_field("pid", STORED);
    builder.add_text_field("session_id", STRING | STORED);
    builder.add_text_field("agent_id", STRING | STORED);
    builder.add_text_field("request_model", STRING | STORED);
    builder.add_text_field("response_model", STRING | STORED);
    builder.build()
}

/// Remove every entry inside `path` without removing `path` itself.
fn wipe_dir(path: &Path) -> Result<()> {
    for entry in fs::read_dir(path).map_err(native_error)? {
        let entry = entry.map_err(native_error)?;
        let child = entry.path();
        if child.is_dir() {
            fs::remove_dir_all(&child).map_err(native_error)?;
        } else {
            fs::remove_file(&child).map_err(native_error)?;
        }
    }
    Ok(())
}

fn assert_identity(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(native_error)?;
    let marker = path.join(FORMAT_FILE);
    if marker.exists() {
        let value = fs::read_to_string(&marker).map_err(native_error)?;
        if value == FORMAT_MARKER {
            return Ok(());
        }
        // A directory we previously owned but under an older/incompatible format:
        // wipe and re-claim rather than refuse. The index is disposable, so this
        // is the self-healing path for legacy layouts.
        wipe_dir(path)?;
        return fs::write(marker, FORMAT_MARKER).map_err(native_error);
    }
    let mut entries = fs::read_dir(path).map_err(native_error)?;
    if entries.next().transpose().map_err(native_error)?.is_some() {
        return Err(native_error(format!(
            "refusing to initialize non-empty unowned search directory {}",
            path.display()
        )));
    }
    fs::write(marker, FORMAT_MARKER).map_err(native_error)
}

fn open_index(path: &Path) -> Result<Index> {
    assert_identity(path)?;
    match Index::open_in_dir(path) {
        Ok(index) => Ok(index),
        Err(_) => Index::create_in_dir(path, schema()).map_err(native_error),
    }
}

#[derive(Clone, Copy)]
struct SearchFields {
    operation_id: Field,
    operation_kind: Field,
    content: Field,
    created_at: Field,
    committed_at: Field,
    endpoint: Field,
    state: Field,
    pid: Field,
    session_id: Field,
    agent_id: Field,
    request_model: Field,
    response_model: Field,
}

fn fields(index: &Index) -> Result<SearchFields> {
    let schema = index.schema();
    Ok(SearchFields {
        operation_id: schema.get_field("operation_id").map_err(native_error)?,
        operation_kind: schema.get_field("operation_kind").map_err(native_error)?,
        content: schema.get_field("content").map_err(native_error)?,
        created_at: schema.get_field("created_at").map_err(native_error)?,
        committed_at: schema.get_field("committed_at").map_err(native_error)?,
        endpoint: schema.get_field("endpoint").map_err(native_error)?,
        state: schema.get_field("state").map_err(native_error)?,
        pid: schema.get_field("pid").map_err(native_error)?,
        session_id: schema.get_field("session_id").map_err(native_error)?,
        agent_id: schema.get_field("agent_id").map_err(native_error)?,
        request_model: schema.get_field("request_model").map_err(native_error)?,
        response_model: schema.get_field("response_model").map_err(native_error)?,
    })
}

fn search_blocking(
    index: &Index,
    reader: &IndexReader,
    fields: SearchFields,
    query_text: String,
    operation_kind: Option<String>,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    if query_text.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    reader.reload().map_err(native_error)?;
    let searcher = reader.searcher();
    let parser = QueryParser::for_index(index, vec![fields.content]);
    let content_query = parser.parse_query(&query_text).map_err(native_error)?;
    let query: Box<dyn Query> = match operation_kind {
        Some(kind) => Box::new(BooleanQuery::new(vec![
            (Occur::Must, content_query),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(fields.operation_kind, &kind),
                    IndexRecordOption::Basic,
                )),
            ),
        ])),
        None => content_query,
    };
    let top_docs = searcher
        .search(&query, &TopDocs::with_limit(limit).order_by_score())
        .map_err(native_error)?;
    let mut hits = Vec::with_capacity(top_docs.len());
    for (score, address) in top_docs {
        let document: TantivyDocument = searcher.doc(address).map_err(native_error)?;
        let Some(operation_id) = document
            .get_first(fields.operation_id)
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let created_at = document
            .get_first(fields.created_at)
            .and_then(|value| value.as_u64())
            .ok_or_else(|| {
                native_error(format!("created_at missing for operation {operation_id}"))
            })?;
        let created_at = i64::try_from(created_at).map_err(|_| {
            native_error(format!(
                "created_at out of i64 range for operation {operation_id}"
            ))
        })?;
        hits.push(SearchHit {
            operation_id: operation_id.to_owned(),
            created_at,
            score: f64::from(score),
        });
    }
    Ok(hits)
}

fn document_text(document: &TantivyDocument, field: Field) -> Option<&str> {
    document.get_first(field).and_then(|value| value.as_str())
}

fn document_u64(document: &TantivyDocument, field: Field) -> Option<u64> {
    document.get_first(field).and_then(|value| value.as_u64())
}

fn document_i64(document: &TantivyDocument, field: Field) -> Option<i64> {
    document.get_first(field).and_then(|value| value.as_i64())
}

#[derive(Debug)]
struct ListCandidate {
    operation_id: String,
    created_at: i64,
}

fn list_search_blocking(
    index: &Index,
    reader: &IndexReader,
    fields: SearchFields,
    request: ListSearchRequest,
) -> Result<ListSearchResult> {
    reader.reload().map_err(native_error)?;
    let searcher = reader.searcher();
    let query: Box<dyn Query> = if request.query.trim().is_empty() {
        Box::new(AllQuery)
    } else {
        let parser = QueryParser::for_index(index, vec![fields.content]);
        parser.parse_query(&request.query).map_err(native_error)?
    };
    let document_count = usize::try_from(searcher.num_docs()).map_err(native_error)?;
    let addresses = if document_count == 0 {
        Vec::new()
    } else {
        searcher
            .search(
                &query,
                &TopDocs::with_limit(document_count).order_by_score(),
            )
            .map_err(native_error)?
    };
    let target_ids = request
        .target_operation_ids
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let model_needle = request.model.as_ref().map(|value| value.to_lowercase());
    let mut matches = Vec::new();
    for (_, address) in addresses {
        let document: TantivyDocument = searcher.doc(address).map_err(native_error)?;
        let Some(operation_id) = document_text(&document, fields.operation_id) else {
            continue;
        };
        let committed_at = document_u64(&document, fields.committed_at).ok_or_else(|| {
            native_error(format!("committed_at missing for operation {operation_id}"))
        })?;
        let committed_at = i64::try_from(committed_at)
            .map_err(|_| native_error("committed_at out of i64 range"))?;
        if committed_at > request.target_committed_at
            || (committed_at == request.target_committed_at && !target_ids.contains(operation_id))
        {
            continue;
        }
        let Some(operation_kind) = document_text(&document, fields.operation_kind) else {
            continue;
        };
        if !request.operation_kinds.is_empty()
            && !request
                .operation_kinds
                .iter()
                .any(|kind| kind == operation_kind)
        {
            continue;
        }
        if request
            .endpoint
            .as_deref()
            .is_some_and(|value| document_text(&document, fields.endpoint) != Some(value))
        {
            continue;
        }
        if !request.states.is_empty()
            && !document_text(&document, fields.state)
                .is_some_and(|state| request.states.iter().any(|value| value == state))
        {
            continue;
        }
        if request
            .pid
            .is_some_and(|value| document_i64(&document, fields.pid) != Some(value))
        {
            continue;
        }
        if request
            .session_id
            .as_deref()
            .is_some_and(|value| document_text(&document, fields.session_id) != Some(value))
        {
            continue;
        }
        if request
            .agent_id
            .as_deref()
            .is_some_and(|value| document_text(&document, fields.agent_id) != Some(value))
        {
            continue;
        }
        if request.main_agent_only.unwrap_or(false)
            && document_text(&document, fields.agent_id).is_some()
        {
            continue;
        }
        if let Some(needle) = &model_needle {
            let request_model = document_text(&document, fields.request_model)
                .unwrap_or_default()
                .to_lowercase();
            let response_model = document_text(&document, fields.response_model)
                .unwrap_or_default()
                .to_lowercase();
            if !request_model.contains(needle) && !response_model.contains(needle) {
                continue;
            }
        }
        let created_at = document_u64(&document, fields.created_at).ok_or_else(|| {
            native_error(format!("created_at missing for operation {operation_id}"))
        })?;
        let created_at =
            i64::try_from(created_at).map_err(|_| native_error("created_at out of i64 range"))?;
        if request.from.is_some_and(|value| created_at < value)
            || request.to.is_some_and(|value| created_at > value)
        {
            continue;
        }
        matches.push(ListCandidate {
            operation_id: operation_id.to_owned(),
            created_at,
        });
    }
    matches.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.operation_id.cmp(&left.operation_id))
    });
    let total =
        u32::try_from(matches.len()).map_err(|_| native_error("list-search total exceeds u32"))?;
    let cursor = request
        .cursor_started_at
        .zip(request.cursor_operation_id.as_deref());
    if request.cursor_require_match.unwrap_or(true)
        && let Some((started_at, operation_id)) = cursor
        && !matches.iter().any(|candidate| {
            candidate.created_at == started_at && candidate.operation_id == operation_id
        })
    {
        return Ok(ListSearchResult {
            operation_ids: Vec::new(),
            total,
            has_older: false,
            has_newer: false,
            invalid_cursor: true,
        });
    }
    let on_requested_side = |candidate: &&ListCandidate| match cursor {
        None => true,
        Some((started_at, operation_id)) if request.direction == "newer" => {
            candidate.created_at > started_at
                || (candidate.created_at == started_at
                    && candidate.operation_id.as_str() > operation_id)
        }
        Some((started_at, operation_id)) => {
            candidate.created_at < started_at
                || (candidate.created_at == started_at
                    && candidate.operation_id.as_str() < operation_id)
        }
    };
    let mut candidates = matches.iter().filter(on_requested_side).collect::<Vec<_>>();
    let limit = request.limit as usize;
    if request.direction == "newer" && candidates.len() > limit {
        candidates = candidates.split_off(candidates.len() - limit);
    } else {
        candidates.truncate(limit);
    }
    let operation_ids = candidates
        .iter()
        .map(|candidate| candidate.operation_id.clone())
        .collect::<Vec<_>>();
    let newest = candidates.first();
    let oldest = candidates.last();
    let has_newer = newest.is_some_and(|boundary| {
        matches.iter().any(|candidate| {
            candidate.created_at > boundary.created_at
                || (candidate.created_at == boundary.created_at
                    && candidate.operation_id > boundary.operation_id)
        })
    });
    let has_older = oldest.is_some_and(|boundary| {
        matches.iter().any(|candidate| {
            candidate.created_at < boundary.created_at
                || (candidate.created_at == boundary.created_at
                    && candidate.operation_id < boundary.operation_id)
        })
    });
    Ok(ListSearchResult {
        operation_ids,
        total,
        has_older,
        has_newer,
        invalid_cursor: false,
    })
}

/// Stateful, long-lived full-text index handle.
///
/// A single `IndexWriter` (one memory arena, one set of indexing threads) lives for
/// the whole handle lifetime — `upsert` only stages documents, and `flush` performs
/// the (batched) commit. This replaces the previous per-document open-writer-commit
/// model that produced one Tantivy segment per API request (segment explosion → mmap
/// blow-up → allocator abort). The JS orchestration layer drives the flush cadence
/// (debounce/batch) and MUST flush before releasing the handle; `IndexWriter::Drop`
/// does not commit.
#[napi]
pub struct HistoryIndex {
    index: Index,
    // `Option` so `close` can explicitly `take()` + drop the writer, releasing the
    // Tantivy directory lock deterministically. Relying on JS GC to finalize the napi
    // handle would leave the lock held across a reconfigure to the SAME path → the next
    // `index.writer()` fails with LockBusy.
    writer: Arc<Mutex<Option<IndexWriter>>>,
    reader: IndexReader,
    fields: SearchFields,
}

#[napi]
impl HistoryIndex {
    // Synchronous constructor: napi-derive forbids async constructors. This is a
    // low-frequency operation (process start / reconfigure), so blocking is fine.
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let path = PathBuf::from(path);
        let index = open_index(&path)?;
        let fields = fields(&index)?;
        let writer: IndexWriter = index.writer(WRITER_MEMORY_BYTES).map_err(native_error)?;
        let reader = index.reader().map_err(native_error)?;
        Ok(Self {
            index,
            writer: Arc::new(Mutex::new(Some(writer))),
            reader,
            fields,
        })
    }

    /// Stage an upsert (delete-by-id then add). Does NOT commit; call `flush`.
    #[napi]
    pub async fn upsert(
        &self,
        operation_id: String,
        operation_kind: String,
        created_at: i64,
        content: String,
    ) -> Result<()> {
        let created_at = u64::try_from(created_at)
            .map_err(|_| native_error("created_at must be non-negative"))?;
        let writer = self.writer.clone();
        let fields = self.fields;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = writer
                .lock()
                .map_err(|_| native_error("history-search writer mutex poisoned"))?;
            let writer = guard
                .as_ref()
                .ok_or_else(|| native_error("history-search index handle is closed"))?;
            writer.delete_term(Term::from_field_text(fields.operation_id, &operation_id));
            writer
                .add_document(doc!(
                    fields.operation_id => operation_id,
                    fields.operation_kind => operation_kind,
                    fields.content => content,
                    fields.created_at => created_at,
                    fields.committed_at => created_at,
                ))
                .map_err(native_error)?;
            Ok(())
        })
        .await
        .map_err(native_error)?
    }

    /// Stage a complete product-list search document. Does NOT commit; call `flush`.
    #[napi]
    pub async fn upsert_summary(&self, document: SearchDocument) -> Result<()> {
        let created_at = u64::try_from(document.created_at)
            .map_err(|_| native_error("created_at must be non-negative"))?;
        let committed_at = u64::try_from(document.committed_at)
            .map_err(|_| native_error("committed_at must be non-negative"))?;
        let writer = self.writer.clone();
        let fields = self.fields;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = writer
                .lock()
                .map_err(|_| native_error("history-search writer mutex poisoned"))?;
            let writer = guard
                .as_ref()
                .ok_or_else(|| native_error("history-search index handle is closed"))?;
            writer.delete_term(Term::from_field_text(
                fields.operation_id,
                &document.operation_id,
            ));
            let mut tantivy_document = doc!(
                fields.operation_id => document.operation_id,
                fields.operation_kind => document.operation_kind,
                fields.content => document.content,
                fields.created_at => created_at,
                fields.committed_at => committed_at,
            );
            if let Some(value) = document.endpoint {
                tantivy_document.add_text(fields.endpoint, value);
            }
            if let Some(value) = document.state {
                tantivy_document.add_text(fields.state, value);
            }
            if let Some(value) = document.pid {
                tantivy_document.add_i64(fields.pid, value);
            }
            if let Some(value) = document.session_id {
                tantivy_document.add_text(fields.session_id, value);
            }
            if let Some(value) = document.agent_id {
                tantivy_document.add_text(fields.agent_id, value);
            }
            if let Some(value) = document.request_model {
                tantivy_document.add_text(fields.request_model, value);
            }
            if let Some(value) = document.response_model {
                tantivy_document.add_text(fields.response_model, value);
            }
            writer
                .add_document(tantivy_document)
                .map_err(native_error)?;
            Ok(())
        })
        .await
        .map_err(native_error)?
    }

    /// Commit all staged documents in a single segment, then reload the reader.
    #[napi]
    pub async fn flush(&self) -> Result<()> {
        let writer = self.writer.clone();
        let reader = self.reader.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            {
                let mut guard = writer
                    .lock()
                    .map_err(|_| native_error("history-search writer mutex poisoned"))?;
                let writer = guard
                    .as_mut()
                    .ok_or_else(|| native_error("history-search index handle is closed"))?;
                writer.commit().map_err(native_error)?;
            }
            reader.reload().map_err(native_error)?;
            Ok(())
        })
        .await
        .map_err(native_error)?
    }

    #[napi]
    pub async fn search(
        &self,
        query: String,
        operation_kind: Option<String>,
        limit: u32,
    ) -> Result<Vec<SearchHit>> {
        let index = self.index.clone();
        let reader = self.reader.clone();
        let fields = self.fields;
        tokio::task::spawn_blocking(move || {
            search_blocking(
                &index,
                &reader,
                fields,
                query,
                operation_kind,
                limit as usize,
            )
        })
        .await
        .map_err(native_error)?
    }

    #[napi]
    pub async fn list_search(&self, request: ListSearchRequest) -> Result<ListSearchResult> {
        let index = self.index.clone();
        let reader = self.reader.clone();
        let fields = self.fields;
        tokio::task::spawn_blocking(move || list_search_blocking(&index, &reader, fields, request))
            .await
            .map_err(native_error)?
    }

    /// Commit staged documents, then drop the writer to release the Tantivy directory
    /// lock (so a new handle on the same path can open immediately). Idempotent.
    #[napi]
    pub async fn close(&self) -> Result<()> {
        let writer = self.writer.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut guard = writer
                .lock()
                .map_err(|_| native_error("history-search writer mutex poisoned"))?;
            if let Some(mut writer) = guard.take() {
                writer.commit().map_err(native_error)?;
                // `writer` dropped here → releases the directory lock.
            }
            Ok(())
        })
        .await
        .map_err(native_error)?
    }
}
