use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use napi::{Error, Result, Status};
use napi_derive::napi;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, STORED, STRING, Schema, TEXT, TantivyDocument, Value,
};
use tantivy::{Index, IndexReader, IndexWriter, Term, doc};

// Bump this whenever the on-disk index layout or the indexed corpus semantics change.
// A directory that carries an OLDER copilot-owned marker is transparently wiped and
// rebuilt (the index is disposable and never authoritative), so incompatible legacy
// indexes self-heal instead of degrading forever. See `assert_identity`.
const FORMAT_MARKER: &str = "copilot-api-history-search-tantivy-v2\n";
const FORMAT_FILE: &str = "FORMAT";
const WRITER_MEMORY_BYTES: usize = 50_000_000;

#[napi(object)]
pub struct SearchHit {
    pub operation_id: String,
    pub created_at: i64,
    pub score: f64,
}

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("operation_id", STRING | STORED);
    builder.add_text_field("operation_kind", STRING | STORED);
    builder.add_text_field("content", TEXT);
    builder.add_u64_field("created_at", STORED);
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

fn fields(index: &Index) -> Result<(Field, Field, Field, Field)> {
    let schema = index.schema();
    Ok((
        schema.get_field("operation_id").map_err(native_error)?,
        schema.get_field("operation_kind").map_err(native_error)?,
        schema.get_field("content").map_err(native_error)?,
        schema.get_field("created_at").map_err(native_error)?,
    ))
}

fn search_blocking(
    index: &Index,
    reader: &IndexReader,
    fields: (Field, Field, Field, Field),
    query_text: String,
    operation_kind: Option<String>,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    if query_text.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let (id_field, kind_field, content_field, created_field) = fields;
    reader.reload().map_err(native_error)?;
    let searcher = reader.searcher();
    let parser = QueryParser::for_index(index, vec![content_field]);
    let content_query = parser.parse_query(&query_text).map_err(native_error)?;
    let query: Box<dyn Query> = match operation_kind {
        Some(kind) => Box::new(BooleanQuery::new(vec![
            (Occur::Must, content_query),
            (
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(kind_field, &kind),
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
            .get_first(id_field)
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let created_at = document
            .get_first(created_field)
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
    fields: (Field, Field, Field, Field),
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
        let (id_field, kind_field, content_field, created_field) = self.fields;
        tokio::task::spawn_blocking(move || -> Result<()> {
            let guard = writer
                .lock()
                .map_err(|_| native_error("history-search writer mutex poisoned"))?;
            let writer = guard
                .as_ref()
                .ok_or_else(|| native_error("history-search index handle is closed"))?;
            writer.delete_term(Term::from_field_text(id_field, &operation_id));
            writer
                .add_document(doc!(
                    id_field => operation_id,
                    kind_field => operation_kind,
                    content_field => content,
                    created_field => created_at,
                ))
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
            search_blocking(&index, &reader, fields, query, operation_kind, limit as usize)
        })
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
