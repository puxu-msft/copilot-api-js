use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use napi::{Error, Result, Status};
use napi_derive::napi;
use tantivy::collector::TopDocs;
use tantivy::columnar::{Column, StrColumn};
use tantivy::query::{AllQuery, BooleanQuery, EnableScoring, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{
    FAST, Field, INDEXED, IndexRecordOption, STORED, STRING, Schema, TEXT, TantivyDocument, Value,
};
use tantivy::{DocId, Index, IndexReader, IndexWriter, SegmentReader, Term, doc};

// Bump this whenever the on-disk index layout or the indexed corpus semantics change.
// A directory that carries an OLDER copilot-owned marker is transparently wiped and
// rebuilt (the index is disposable and never authoritative), so incompatible legacy
// indexes self-heal instead of degrading forever. See `assert_identity`.
const FORMAT_MARKER: &str = "copilot-api-history-search-tantivy-v4\n";
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

/// The index's OWN commit state, read from Tantivy rather than from any marker this
/// project writes beside it.
///
/// The JS tail cursor records this at publish time so a later process can prove the
/// durable frontier that cursor claims is still backed by THIS index. Both fields move
/// only one way while an index lives: commits and merges raise `opstamp`, and a tailed
/// index never loses every document. Two reachable paths break that continuity while the
/// cursor file survives — `open_index` falling back to `create_in_dir` after
/// `Index::open_in_dir` fails on damaged metadata, and an index directory restored from
/// an older snapshot — and those are exactly the cases where a surviving cursor must stop
/// being believed. (A FORMAT-marker bump is NOT one of them: `assert_identity` wipes the
/// whole directory, cursor included.)
#[napi(object)]
pub struct IndexGeneration {
    pub doc_count: i64,
    pub opstamp: i64,
}

fn native_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}

/// A query string the parser rejects is a BAD REQUEST, not a sidecar failure.
///
/// It carries `Status::InvalidArg` so the caller can tell the two apart: the search box is free
/// text, and `error:` or a leading `-` are things a user types, not evidence that the index is
/// broken. Reported as a generic failure it became "the sidecar is unavailable", which took down
/// the whole listing — including the in-flight half, which needs no index at all.
fn invalid_query_error(error: impl std::fmt::Display) -> Error {
    Error::new(Status::InvalidArg, error.to_string())
}

/// Every field `list_search` filters, sorts, or paginates on is `FAST` (columnar), because
/// that path reads them per candidate document. `STORED` is kept alongside for the
/// score-search path and for debuggability; only `content` stays purely inverted.
fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("operation_id", STRING | STORED | FAST);
    builder.add_text_field("operation_kind", STRING | STORED | FAST);
    builder.add_text_field("content", TEXT);
    builder.add_u64_field("created_at", STORED | FAST);
    builder.add_u64_field("committed_at", STORED | FAST);
    builder.add_text_field("endpoint", STRING | STORED | FAST);
    builder.add_text_field("state", STRING | STORED | FAST);
    // INDEXED so an exact-pid list query can be answered by the inverted index instead of
    // by visiting every document; FAST so the post-filter can read it columnar-side.
    builder.add_i64_field("pid", INDEXED | STORED | FAST);
    builder.add_text_field("session_id", STRING | STORED | FAST);
    builder.add_text_field("agent_id", STRING | STORED | FAST);
    builder.add_text_field("request_model", STRING | STORED | FAST);
    builder.add_text_field("response_model", STRING | STORED | FAST);
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

/// Columnar (fast-field) readers for one segment, opened once per `list_search` call.
///
/// `list_search` reads every field it filters and orders on from these columns rather than
/// from the stored document. A stored-field read decompresses a whole block per hit, so the
/// previous `searcher.doc(address)`-per-hit shape made a page cost track the number of
/// *hits* instead of the number of *results* — measured on a synthetic corpus by
/// `exp/history-search-list-perf/bench.ts`, a 1%-selective session filter over 100k
/// documents cost the same 254 ms as no filter at all.
///
/// Numeric columns are `Option` because a segment in which no document carried the field
/// has no column for it at all (`pid` is optional in `SearchDocument`); that is an ordinary
/// state meaning "absent for every document here", not an error.
struct SegmentColumns {
    operation_id: Option<StrColumn>,
    operation_kind: Option<StrColumn>,
    endpoint: Option<StrColumn>,
    state: Option<StrColumn>,
    session_id: Option<StrColumn>,
    agent_id: Option<StrColumn>,
    request_model: Option<StrColumn>,
    response_model: Option<StrColumn>,
    created_at: Option<Column<u64>>,
    committed_at: Option<Column<u64>>,
    pid: Option<Column<i64>>,
}

impl SegmentColumns {
    fn open(reader: &SegmentReader) -> Result<Self> {
        let readers = reader.fast_fields();
        Ok(Self {
            operation_id: readers.str("operation_id").map_err(native_error)?,
            operation_kind: readers.str("operation_kind").map_err(native_error)?,
            endpoint: readers.str("endpoint").map_err(native_error)?,
            state: readers.str("state").map_err(native_error)?,
            session_id: readers.str("session_id").map_err(native_error)?,
            agent_id: readers.str("agent_id").map_err(native_error)?,
            request_model: readers.str("request_model").map_err(native_error)?,
            response_model: readers.str("response_model").map_err(native_error)?,
            created_at: readers.column_opt("created_at").map_err(native_error)?,
            committed_at: readers.column_opt("committed_at").map_err(native_error)?,
            pid: readers.column_opt("pid").map_err(native_error)?,
        })
    }
}

/// Resolve one text filter to the term ordinals that can satisfy it in this segment.
///
/// `None` means "no filter". `Some(ordinals)` is the allowed set, and an EMPTY set is a
/// meaningful answer — the value exists nowhere in this segment, so nothing here matches.
///
/// An EMPTY STRING carries no filtering intent and is dropped rather than resolved. No document
/// stores one, so resolving it produced an empty allowed set that rejected every document: a
/// `?endpoint=` with no value silently emptied the persisted half of the page, while the SQL path
/// treated the same URL as unfiltered. The pushdown builders already refuse to push an empty term,
/// so dropping it here is what makes the two halves agree.
///
/// Filters are compared by ordinal rather than by string because a term lookup is not free:
/// `Dictionary::ord_to_term` re-decodes an sstable block from its first ordinal on every
/// call, so resolving per document is quadratic in block size. Resolving once per segment
/// turns each per-document check into a single columnar `u64` read.
fn resolve_any_of(column: Option<&StrColumn>, values: &[String]) -> Result<Option<Vec<u64>>> {
    let values: Vec<&String> = values.iter().filter(|value| !value.is_empty()).collect();
    if values.is_empty() {
        return Ok(None);
    }
    let Some(column) = column else {
        return Ok(Some(Vec::new()));
    };
    let mut ordinals = Vec::with_capacity(values.len());
    for value in values {
        if let Some(ordinal) = column
            .dictionary()
            .term_ord(value.as_bytes())
            .map_err(native_error)?
        {
            ordinals.push(ordinal);
        }
    }
    Ok(Some(ordinals))
}

/// Equality counterpart of [`resolve_any_of`], with the same empty-string rule: `Some("")` is
/// "no filter", not "match the empty term".
fn resolve_equals(column: Option<&StrColumn>, value: Option<&str>) -> Result<Option<Vec<u64>>> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some(column) = column else {
        return Ok(Some(Vec::new()));
    };
    Ok(Some(
        column
            .dictionary()
            .term_ord(value.as_bytes())
            .map_err(native_error)?
            .into_iter()
            .collect(),
    ))
}

/// Ordinals whose term contains `needle` (case-insensitive), by streaming the segment's
/// dictionary once. A model field holds a handful of distinct values, so this replaces a
/// per-document lowercase+substring test with a set membership check on a small vector.
fn resolve_contains(column: Option<&StrColumn>, needle: &str) -> Result<Vec<u64>> {
    let Some(column) = column else {
        return Ok(Vec::new());
    };
    let term_count = column.num_terms() as u64;
    let mut ordinals = Vec::new();
    let mut ordinal = 0u64;
    let complete = column
        .dictionary()
        .sorted_ords_to_term_cb(0..term_count, |bytes| {
            let term = std::str::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if term.to_lowercase().contains(needle) {
                ordinals.push(ordinal);
            }
            ordinal += 1;
            Ok(())
        })
        .map_err(native_error)?;
    // Silently returning a short ordinal set here would under-match the filter rather than
    // fail, so a dictionary that does not yield every ordinal it claims is an error.
    if !complete || ordinal != term_count {
        return Err(native_error(
            "term dictionary did not yield every ordinal while resolving a substring filter",
        ));
    }
    Ok(ordinals)
}

/// The first term ordinal for `doc`, mirroring the stored-document `get_first` semantics
/// the filters were written against: no value reads as absent, not as an empty string.
fn first_ord(column: Option<&StrColumn>, doc: DocId) -> Option<u64> {
    column?.ords().first(doc)
}

fn ord_allowed(column: Option<&StrColumn>, doc: DocId, allowed: &[u64]) -> bool {
    first_ord(column, doc).is_some_and(|ordinal| allowed.contains(&ordinal))
}

/// Turn one segment's surviving `(operation-id ordinal, created_at)` pairs into candidates,
/// resolving every id in a SINGLE forward pass over the segment's term dictionary.
///
/// `sorted_ords_to_term_cb` requires ascending ordinals and streams the sstable once, where
/// `ord_to_term` re-decodes a block from its first ordinal per call. Resolving per document
/// measured 16x SLOWER than the stored-document read this path replaced, on an unfiltered
/// page over 20k documents — the batched pass is what makes the columnar path a win rather
/// than a regression.
fn resolve_operation_ids(
    column: Option<&StrColumn>,
    survivors: &[(u64, i64)],
    matches: &mut Vec<ListCandidate>,
) -> Result<()> {
    if survivors.is_empty() {
        return Ok(());
    }
    let Some(column) = column else {
        return Err(native_error(
            "operation_id fast field missing for a segment with matching documents",
        ));
    };
    let mut order: Vec<usize> = (0..survivors.len()).collect();
    order.sort_unstable_by_key(|&index| survivors[index].0);
    let base = matches.len();
    matches.extend(survivors.iter().map(|&(_, created_at)| ListCandidate {
        operation_id: String::new(),
        created_at,
    }));
    let mut cursor = 0usize;
    let complete = column
        .dictionary()
        .sorted_ords_to_term_cb(order.iter().map(|&index| survivors[index].0), |bytes| {
            let term = std::str::from_utf8(bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            matches[base + order[cursor]].operation_id = term.to_owned();
            cursor += 1;
            Ok(())
        })
        .map_err(native_error)?;
    if !complete || cursor != survivors.len() {
        return Err(native_error(
            "operation_id term dictionary did not resolve every matching document",
        ));
    }
    Ok(())
}

fn text_term_query(field: Field, value: &str) -> Box<dyn Query> {
    Box::new(TermQuery::new(
        Term::from_field_text(field, value),
        IndexRecordOption::Basic,
    ))
}

/// A `Must` clause matching any of `values`, or `None` when the filter cannot be pushed.
///
/// Pushdown is only ever allowed to be *looser* than the per-document filter, which stays
/// the semantic authority. An empty string is therefore never pushed: the raw tokenizer
/// emits no term for it, so a pushed clause would drop documents the post-filter keeps.
fn any_of_query(field: Field, values: &[String]) -> Option<Box<dyn Query>> {
    if values.is_empty() || values.iter().any(|value| value.is_empty()) {
        return None;
    }
    Some(Box::new(BooleanQuery::new(
        values
            .iter()
            .map(|value| (Occur::Should, text_term_query(field, value)))
            .collect(),
    )))
}

fn equals_query(field: Field, value: Option<&str>) -> Option<Box<dyn Query>> {
    let value = value?;
    if value.is_empty() {
        return None;
    }
    Some(text_term_query(field, value))
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
    let content_query: Box<dyn Query> = if request.query.trim().is_empty() {
        Box::new(AllQuery)
    } else {
        let parser = QueryParser::for_index(index, vec![fields.content]);
        parser
            .parse_query(&request.query)
            .map_err(invalid_query_error)?
    };
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, content_query)];
    clauses.extend(
        [
            any_of_query(fields.operation_kind, &request.operation_kinds),
            any_of_query(fields.state, &request.states),
            equals_query(fields.endpoint, request.endpoint.as_deref()),
            equals_query(fields.session_id, request.session_id.as_deref()),
            equals_query(fields.agent_id, request.agent_id.as_deref()),
            request.pid.map(|value| -> Box<dyn Query> {
                Box::new(TermQuery::new(
                    Term::from_field_i64(fields.pid, value),
                    IndexRecordOption::Basic,
                ))
            }),
        ]
        .into_iter()
        .flatten()
        .map(|query| (Occur::Must, query)),
    );
    let query: Box<dyn Query> = if clauses.len() == 1 {
        clauses.remove(0).1
    } else {
        Box::new(BooleanQuery::new(clauses))
    };
    // Scoring is dead weight here: the result order is (created_at desc, operation_id desc),
    // never relevance.
    let weight = query
        .weight(EnableScoring::disabled_from_searcher(&searcher))
        .map_err(native_error)?;
    // An empty needle matched every document under the previous `unwrap_or_default()`
    // substring test (`"".contains("") == true`), including documents carrying no model at
    // all — so it is not a filter.
    let model_needle = request
        .model
        .as_ref()
        .map(|value| value.to_lowercase())
        .filter(|value| !value.is_empty());
    let mut matches = Vec::new();
    for segment_reader in searcher.segment_readers() {
        let columns = SegmentColumns::open(segment_reader)?;
        let operation_kind_ords = resolve_any_of(
            columns.operation_kind.as_ref(),
            &request.operation_kinds,
        )?;
        let state_ords = resolve_any_of(columns.state.as_ref(), &request.states)?;
        let endpoint_ords = resolve_equals(columns.endpoint.as_ref(), request.endpoint.as_deref())?;
        let session_ords =
            resolve_equals(columns.session_id.as_ref(), request.session_id.as_deref())?;
        let agent_ords = resolve_equals(columns.agent_id.as_ref(), request.agent_id.as_deref())?;
        let target_ords = resolve_any_of(
            columns.operation_id.as_ref(),
            &request.target_operation_ids,
        )?
        .unwrap_or_default();
        let model_ords = match &model_needle {
            None => None,
            Some(needle) => Some((
                resolve_contains(columns.request_model.as_ref(), needle)?,
                resolve_contains(columns.response_model.as_ref(), needle)?,
            )),
        };
        // `Weight::for_each_no_score` walks the raw docset, which CAN contain deleted
        // documents — unlike a collector-driven search, where the searcher filters them.
        // Only `Weight::count` consults the alive bitset on its own, so this path has to.
        //
        // This is REACHABLE and is exercised by the supersede regression in
        // `tests/history/search/daemon.it.test.ts`. An earlier note here claimed the opposite,
        // on the strength of a probe run that reported `deletes: null` for every live segment.
        // Re-running that same probe six times produced a tombstone five times
        // (`exp/history-search-list-perf/supersede-probe.ts`): a `flush` spreads documents over
        // several segments, and whether a delete leaves a `.del` behind depends on whether the
        // superseded document's segment still holds a live document afterwards. The run that
        // saw nothing had hit the case where it did not, and the segment was dropped whole.
        //
        // Dropping this check would silently resurrect superseded operations whenever the
        // tombstone does survive.
        let alive = segment_reader.alive_bitset();
        let mut docs: Vec<DocId> = Vec::new();
        weight
            .for_each_no_score(segment_reader, &mut |batch| docs.extend_from_slice(batch))
            .map_err(native_error)?;
        // (operation-id ordinal, created_at) for the survivors; ids are resolved in one
        // dictionary pass below rather than one lookup per document.
        let mut survivors: Vec<(u64, i64)> = Vec::new();
        for doc in docs {
            if alive.is_some_and(|bitset| !bitset.is_alive(doc)) {
                continue;
            }
            let Some(operation_ord) = first_ord(columns.operation_id.as_ref(), doc) else {
                continue;
            };
            let committed_at = columns
                .committed_at
                .as_ref()
                .and_then(|column| column.first(doc))
                .ok_or_else(|| native_error("committed_at missing for an indexed operation"))?;
            let committed_at = i64::try_from(committed_at)
                .map_err(|_| native_error("committed_at out of i64 range"))?;
            if committed_at > request.target_committed_at
                || (committed_at == request.target_committed_at
                    && !target_ords.contains(&operation_ord))
            {
                continue;
            }
            // operation_kind is required, filtered or not — matching the previous
            // `let Some(kind) = ... else { continue }`.
            if first_ord(columns.operation_kind.as_ref(), doc).is_none() {
                continue;
            }
            if let Some(allowed) = &operation_kind_ords
                && !ord_allowed(columns.operation_kind.as_ref(), doc, allowed)
            {
                continue;
            }
            if let Some(allowed) = &endpoint_ords
                && !ord_allowed(columns.endpoint.as_ref(), doc, allowed)
            {
                continue;
            }
            if let Some(allowed) = &state_ords
                && !ord_allowed(columns.state.as_ref(), doc, allowed)
            {
                continue;
            }
            if let Some(pid) = request.pid
                && columns
                    .pid
                    .as_ref()
                    .and_then(|column| column.first(doc))
                    .is_none_or(|value| value != pid)
            {
                continue;
            }
            if let Some(allowed) = &session_ords
                && !ord_allowed(columns.session_id.as_ref(), doc, allowed)
            {
                continue;
            }
            if let Some(allowed) = &agent_ords
                && !ord_allowed(columns.agent_id.as_ref(), doc, allowed)
            {
                continue;
            }
            if request.main_agent_only.unwrap_or(false)
                && first_ord(columns.agent_id.as_ref(), doc).is_some()
            {
                continue;
            }
            if let Some((request_models, response_models)) = &model_ords
                && !ord_allowed(columns.request_model.as_ref(), doc, request_models)
                && !ord_allowed(columns.response_model.as_ref(), doc, response_models)
            {
                continue;
            }
            let created_at = columns
                .created_at
                .as_ref()
                .and_then(|column| column.first(doc))
                .ok_or_else(|| native_error("created_at missing for an indexed operation"))?;
            let created_at = i64::try_from(created_at)
                .map_err(|_| native_error("created_at out of i64 range"))?;
            if request.from.is_some_and(|value| created_at < value)
                || request.to.is_some_and(|value| created_at > value)
            {
                continue;
            }
            survivors.push((operation_ord, created_at));
        }
        resolve_operation_ids(columns.operation_id.as_ref(), &survivors, &mut matches)?;
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

    /// Read this index's own commit state (see `IndexGeneration`). Reloads the reader
    /// first, so the count reflects the latest commit rather than the snapshot the
    /// reader happened to be holding.
    #[napi]
    pub async fn generation(&self) -> Result<IndexGeneration> {
        let index = self.index.clone();
        let reader = self.reader.clone();
        tokio::task::spawn_blocking(move || -> Result<IndexGeneration> {
            reader.reload().map_err(native_error)?;
            let doc_count = i64::try_from(reader.searcher().num_docs())
                .map_err(|_| native_error("index doc count out of i64 range"))?;
            let metas = index.load_metas().map_err(native_error)?;
            let opstamp = i64::try_from(metas.opstamp)
                .map_err(|_| native_error("index opstamp out of i64 range"))?;
            Ok(IndexGeneration {
                doc_count,
                opstamp,
            })
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
