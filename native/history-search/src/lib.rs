use std::fs;
use std::path::{Path, PathBuf};

use napi::{Error, Result, Status};
use napi_derive::napi;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, STORED, STRING, Schema, TEXT, TantivyDocument, Value,
};
use tantivy::{Index, IndexWriter, Term, doc};

const FORMAT_MARKER: &str = "copilot-api-history-search-tantivy-v1\n";
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

fn assert_identity(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(native_error)?;
    let marker = path.join(FORMAT_FILE);
    if marker.exists() {
        let value = fs::read_to_string(&marker).map_err(native_error)?;
        if value != FORMAT_MARKER {
            return Err(native_error(format!(
                "unsupported Tantivy sidecar identity at {}",
                path.display()
            )));
        }
        return Ok(());
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

fn initialize_sync(path: PathBuf) -> Result<()> {
    open_index(&path).map(|_| ())
}

fn upsert_sync(
    path: PathBuf,
    operation_id: String,
    operation_kind: String,
    created_at: u64,
    content: String,
) -> Result<()> {
    let index = open_index(&path)?;
    let (id_field, kind_field, content_field, created_field) = fields(&index)?;
    let mut writer: IndexWriter = index.writer(WRITER_MEMORY_BYTES).map_err(native_error)?;
    writer.delete_term(Term::from_field_text(id_field, &operation_id));
    writer
        .add_document(doc!(
            id_field => operation_id,
            kind_field => operation_kind,
            content_field => content,
            created_field => created_at,
        ))
        .map_err(native_error)?;
    writer.commit().map_err(native_error)?;
    Ok(())
}

fn search_sync(
    path: PathBuf,
    query_text: String,
    operation_kind: Option<String>,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    if query_text.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let index = open_index(&path)?;
    let (id_field, kind_field, content_field, created_field) = fields(&index)?;
    let reader = index.reader().map_err(native_error)?;
    reader.reload().map_err(native_error)?;
    let searcher = reader.searcher();
    let parser = QueryParser::for_index(&index, vec![content_field]);
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

#[napi]
pub async fn initialize(path: String) -> Result<()> {
    tokio::task::spawn_blocking(move || initialize_sync(PathBuf::from(path)))
        .await
        .map_err(native_error)??;
    Ok(())
}

#[napi]
pub async fn upsert_operation(
    path: String,
    operation_id: String,
    operation_kind: String,
    created_at: i64,
    content: String,
) -> Result<()> {
    let created_at =
        u64::try_from(created_at).map_err(|_| native_error("created_at must be non-negative"))?;
    tokio::task::spawn_blocking(move || {
        upsert_sync(
            PathBuf::from(path),
            operation_id,
            operation_kind,
            created_at,
            content,
        )
    })
    .await
    .map_err(native_error)??;
    Ok(())
}

#[napi]
pub async fn search_operations(
    path: String,
    query: String,
    operation_kind: Option<String>,
    limit: u32,
) -> Result<Vec<SearchHit>> {
    tokio::task::spawn_blocking(move || {
        search_sync(PathBuf::from(path), query, operation_kind, limit as usize)
    })
    .await
    .map_err(native_error)?
}
