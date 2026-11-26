mod assistant;
mod notes;
mod photos;
mod planner;
mod store;
use anyhow::{bail, Context, Result};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as Param, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use st_core::{data_dir, field, safe_name, socket_path, MAX_LINE};
use std::{
    collections::HashMap,
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use store::{EditResult, Store};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};
use tower_http::services::ServeDir;
#[derive(Clone)]
struct App {
    store: Arc<Mutex<Store>>,
    data: PathBuf,
    owner: String,
    origin: String,
    panel_key: String,
    claims: Arc<Mutex<HashMap<String, (Instant, String)>>>,
    planner: Option<planner::Client>,
}
type HttpError = (StatusCode, String);
fn err(e: impl std::fmt::Display) -> HttpError {
    (StatusCode::BAD_REQUEST, e.to_string())
}
fn stable_key(value: &str) -> uuid::Uuid {
    uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, value.as_bytes())
}
fn is_panel(a: &App, h: &HeaderMap) -> bool {
    !a.panel_key.is_empty()
        && h.get("authorization")
            .and_then(|x| x.to_str().ok())
            .and_then(|x| x.strip_prefix("Bearer "))
            == Some(&a.panel_key)
}
fn auth(a: &App, h: &HeaderMap) -> Result<(), HttpError> {
    if is_panel(a, h)
        || (!a.owner.is_empty()
            && h.get("tailscale-user-login").and_then(|x| x.to_str().ok()) == Some(&a.owner))
    {
        Ok(())
    } else {
        Err((
            StatusCode::UNAUTHORIZED,
            "Use the configured private Serve URL or panel credential".into(),
        ))
    }
}
async fn headers(State(a): State<App>, req: axum::extract::Request, next: Next) -> Response {
    let h = req.headers();
    let origin = h.get("origin").and_then(|x| x.to_str().ok());
    let host = h.get("host").and_then(|x| x.to_str().ok()).unwrap_or("");
    if !(host == a.origin.trim_start_matches("https://")
        || host.split(':').next() == Some("127.0.0.1")
        || host.split(':').next() == Some("localhost"))
        || origin.is_some_and(|o| o != a.origin)
        || h.get("sec-fetch-site").is_some_and(|v| v == "cross-site")
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let embedded = req.uri().path().starts_with("/api/asset/app/");
    let mut resp = next.run(req).await;
    resp.headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    resp.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    resp.headers_mut().insert(header::CONTENT_SECURITY_POLICY,(if embedded {"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'"} else {"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}).parse().unwrap());
    resp
}
async fn snapshot(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    Ok(Json(display_snapshot(&a).await.map_err(err)?))
}
async fn display_snapshot(a: &App) -> Result<Value> {
    let mut value = a.store.lock().unwrap().snapshot()?;
    if let Some(client) = &a.planner {
        let remote = client.display().await;
        let records = value["records"].as_array_mut().unwrap();
        records.retain(|r| r["kind"] == "note");
        records.extend(
            remote["records"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|r| {
                    r["kind"] != "task"
                        || r["project_id"].is_null()
                        || remote["projects"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|project| {
                                project["id"] == r["project_id"]
                                    && project["visible_on_screen"] != false
                            })
                })
                .cloned(),
        );
        value["task_projects"] = remote["projects"].clone();
        value["planner_status"] = remote["status"].clone();
    }
    Ok(value)
}
fn planner_error(error: anyhow::Error) -> HttpError {
    let status = error
        .downcast_ref::<planner::Failure>()
        .and_then(|e| StatusCode::from_u16(e.status).ok())
        .unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
    (status, error.to_string())
}
async fn planner_read(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    let client = a.planner.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Planner is not configured".into(),
    ))?;
    Ok(Json(
        client
            .request("list", json!({"fresh":true}), None)
            .await
            .map_err(planner_error)?,
    ))
}
async fn planner_write(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    let client = a.planner.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Planner is not configured".into(),
    ))?;
    let action = field(&v, "action").map_err(err)?;
    if !matches!(action, "save" | "complete" | "delete") {
        return Err(err("Unknown planner action"));
    }
    let key = field(&v, "idempotency_key").map_err(err)?;
    Ok(Json(
        client
            .request(action, v["args"].clone(), Some(format!("http/{key}")))
            .await
            .map_err(planner_error)?,
    ))
}
async fn view(
    State(a): State<App>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    {
        let mut store = a.store.lock().unwrap();
        if v.get("theme").is_some() {
            if v.get("name").is_some() {
                return Err(err("Choose a theme or a view per request"));
            }
            store
                .set_theme(field(&v, "theme").map_err(err)?)
                .map_err(err)?;
        } else {
            store
                .call("room", &json!({"op":"tools","name":"show_view","args":v}))
                .map_err(err)?;
        }
    }
    Ok(Json(display_snapshot(&a).await.map_err(err)?))
}
async fn edit_record(
    State(a): State<App>,
    h: HeaderMap,
    Param(id): Param<String>,
    Json(patch): Json<Value>,
) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    if !patch.is_object() {
        return Err(err("Expected an edit object"));
    }
    if let Some(client) = &a.planner {
        if uuid::Uuid::parse_str(&id).is_ok() {
            let mut args = patch.clone();
            args["id"] = json!(id);
            let action = if patch["done"] == true {
                "complete"
            } else {
                "save"
            };
            if action == "complete" {
                if patch.as_object().is_none_or(|p| p.len() != 2) {
                    return Err(err("Expected completion and version"));
                }
                args.as_object_mut().unwrap().remove("done");
            }
            let operation = json!([id, patch]).to_string();
            // The expected version makes a retry of a checkbox completion unique
            // to that occurrence, even if the HTTP reply was lost.
            client
                .request(
                    action,
                    args,
                    Some(format!("panel/{}", stable_key(&operation))),
                )
                .await
                .map_err(planner_error)?;
            return Ok(Json(display_snapshot(&a).await.map_err(err)?));
        }
    }
    let id = id.parse::<i64>().map_err(err)?;
    let result = {
        let mut store = a.store.lock().unwrap();
        if a.planner.is_some() {
            let kind: Option<String> = store
                .db
                .query_row("SELECT kind FROM records WHERE id=?", [id], |r| r.get(0))
                .ok();
            if kind.as_deref().is_some_and(|k| k != "note") {
                return Err(err("Use the migrated planner record"));
            }
        }
        store.edit_record(id, &patch).map_err(err)?
    };
    match result {
        EditResult::Saved => Ok(Json(display_snapshot(&a).await.map_err(err)?)),
        EditResult::Missing => Err((StatusCode::NOT_FOUND, "Record no longer exists".into())),
        EditResult::Conflict => Err((StatusCode::CONFLICT, "Record has changed".into())),
    }
}
async fn updates(State(a): State<App>, h: HeaderMap) -> Result<impl IntoResponse, HttpError> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    auth(&a, &h)?;
    let stream = async_stream::stream! {let mut last=String::new();loop{
        let current=display_snapshot(&a).await.map(|s|s.to_string()).unwrap_or_default();
        if !current.is_empty()&&current!=last{last=current.clone();yield Ok::<_,std::convert::Infallible>(Event::default().data(current));}
        tokio::time::sleep(Duration::from_secs(1)).await;
    }};
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
async fn upload_frame(
    State(a): State<App>,
    h: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, HttpError> {
    if !is_panel(&a, &h) {
        return Err((StatusCode::UNAUTHORIZED, "Panel credential required".into()));
    }
    if !body.starts_with(b"\x89PNG\r\n\x1a\n") || body.len() < 33 {
        return Err(err("Expected PNG"));
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let record = json!({"display":"SCR-SM1","timestamp":stamp,"image":format!("data:image/png;base64,{}",STANDARD.encode(&body))});
    let tmp = a.data.join(format!(".frame-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, record.to_string()).map_err(err)?;
    fs::rename(tmp, a.data.join("frame.json")).map_err(err)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn frame(State(a): State<App>, h: HeaderMap) -> Result<Json<Value>, HttpError> {
    auth(&a, &h)?;
    let path = a.data.join("frame.json");
    if !path.exists() {
        return Ok(Json(Value::Null));
    }
    Ok(Json(
        serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?,
    ))
}
async fn asset(
    State(a): State<App>,
    h: HeaderMap,
    Param((kind, name)): Param<(String, String)>,
) -> Result<Response, HttpError> {
    // A sandboxed custom app is a fixed, self-contained HTML file. Media IDs never resolve a client path.
    auth(&a, &h)?;
    safe_name(&name).map_err(err)?;
    let (folder, ext, mime) = match kind.as_str() {
        "photo" => ("photos", "jpg", "image/jpeg"),
        "app" => ("apps", "html", "text/html; charset=utf-8"),
        _ => return Err(err("Unknown asset type")),
    };
    if kind == "app" {
        let html = a
            .store
            .lock()
            .unwrap()
            .db
            .query_row("SELECT html FROM apps WHERE name=?", [name], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|_| (StatusCode::NOT_FOUND, "App unavailable".into()))?;
        return Ok(([(header::CONTENT_TYPE, mime)], html).into_response());
    }
    let data = fs::read(a.data.join(folder).join(format!("{name}.{ext}")))
        .map_err(|_| (StatusCode::NOT_FOUND, "Asset unavailable".into()))?;
    Ok(([(header::CONTENT_TYPE, mime)], data).into_response())
}
async fn call(a: &App, device: &str, v: &Value) -> Result<Value> {
    if v["op"] == "tools" {
        let name = v["name"].as_str().unwrap_or("");
        anyhow::ensure!(v["args"].is_object(), "Expected tool arguments");
        if v["planner"] == true {
            anyhow::ensure!(
                a.planner.is_some(),
                "Planner unavailable: configure STAPP_PLANNER_SOCKET"
            );
        }
        if matches!(
            name,
            "list_notes" | "get_note" | "save_note" | "delete_note"
        ) {
            return a.store.lock().unwrap().notes(device, v);
        }
        if matches!(
            name,
            "photos_status" | "photos_albums" | "photos_recent" | "photos_search" | "photos_show"
        ) {
            a.store.lock().unwrap().authorize_tool(device, v)?;
            let result = photos::request(&json!({"name":name,"args":v["args"]})).await?;
            if name != "photos_show" {
                return Ok(result);
            }
            // Recheck the request lease after the network operation, before changing the panel.
            a.store.lock().unwrap().authorize_tool(device, v)?;
            let id = uuid::Uuid::parse_str(field(&result, "id")?)?;
            let view = format!("immich-{id}");
            let bytes = STANDARD.decode(field(&result, "data")?)?;
            anyhow::ensure!(
                bytes.len() <= 5_000_000 && bytes.starts_with(&[255, 216, 255]),
                "Invalid photo preview"
            );
            let folder = a.data.join("photos");
            fs::create_dir_all(&folder)?;
            let temp = folder.join(format!("{}.tmp", uuid::Uuid::new_v4()));
            fs::write(&temp, bytes)?;
            fs::rename(temp, folder.join(format!("{view}.jpg")))?;
            let mut save = v.clone();
            save["name"] = json!("save_view");
            save["key"] = json!(format!("{}/save", v["key"].as_str().unwrap_or("owner")));
            save["args"] = json!({"name":view,"spec":{"kind":"photo","asset":view}});
            a.store.lock().unwrap().call(device, &save)?;
            let mut show = v.clone();
            show["name"] = json!("show_view");
            show["key"] = json!(format!("{}/show", v["key"].as_str().unwrap_or("owner")));
            show["args"] = json!({"name":view});
            return a.store.lock().unwrap().call(device, &show);
        }
        if name == "save_record" && v["args"]["kind"] == "note" {
            anyhow::ensure!(
                v["args"].get("id").is_none_or(|id| id.is_i64()),
                "Notes use local integer IDs"
            );
        }
        if let Some(client) = &a.planner {
            let remote = matches!(
                name,
                "list_task_projects"
                    | "save_task_project"
                    | "complete_task"
                    | "delete_record"
                    | "get_record"
            ) || name == "list_records"
                || (name == "save_record" && v["args"]["kind"] != "note");
            if remote {
                a.store.lock().unwrap().authorize_tool(device, v)?;
                if name == "list_records" || name == "list_task_projects" {
                    let remote = client.request("list", json!({"fresh":true}), None).await?;
                    if name == "list_task_projects" {
                        return Ok(remote["projects"].clone());
                    }
                    let mut records = a.store.lock().unwrap().snapshot()?["records"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|r| r["kind"] == "note")
                        .cloned()
                        .collect::<Vec<_>>();
                    records.extend(remote["records"].as_array().into_iter().flatten().cloned());
                    return Ok(json!(records));
                }
                let mut args = v["args"].clone();
                let action = match name {
                    "get_record" => "get",
                    "complete_task" => "complete",
                    "delete_record" => "delete",
                    "save_task_project" => {
                        args["kind"] = json!("project");
                        "save"
                    }
                    _ => "save",
                };
                let key = if action == "get" {
                    None
                } else if let Some(job) = v["job"].as_str() {
                    Some(format!("mcp/{job}/{}", field(v, "key")?))
                } else {
                    Some(format!(
                        "owner/{}",
                        v["key"]
                            .as_str()
                            .unwrap_or(&uuid::Uuid::new_v4().to_string())
                    ))
                };
                return client.request(action, args, key).await;
            }
        }
    }
    if v["op"] == "release_wake" {
        let key = format!("{device}/{}", field(v, "id")?);
        a.claims.lock().unwrap().retain(|_, (_, id)| id != &key);
        return Ok(json!(true));
    }
    if v["op"] == "wake" {
        let token = field(v, "id")?;
        uuid::Uuid::parse_str(token)?;
        let overlapping = env::var("STAPP_OVERLAP").as_deref() == Ok("1");
        let now = Instant::now();
        let group = if overlapping { "shared" } else { device };
        if overlapping && device == "room" {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let mut map = a.claims.lock().unwrap();
        map.retain(|_, (when, _)| now.saturating_duration_since(*when) < Duration::from_secs(300));
        let winner = &map
            .entry(group.to_string())
            .or_insert((now, format!("{device}/{token}")))
            .1;
        return Ok(json!({"accepted":winner==&format!("{device}/{token}")}));
    }
    if v["op"] == "ask" && v.get("wake").is_some() {
        let key = format!("{device}/{}", field(v, "wake")?);
        anyhow::ensure!(v["wake"] == v["id"], "Wake and request IDs must match");
        let mut claims = a.claims.lock().unwrap();
        let mut store = a.store.lock().unwrap();
        let existing=store.db.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND device=?2 UNION ALL SELECT 1 FROM voice_answers WHERE id=?1 AND device=?2)",rusqlite::params![field(v,"id")?,device],|r|r.get::<_,bool>(0))?;
        anyhow::ensure!(
            existing
                || claims
                    .values()
                    .any(|(t, id)| id == &key && t.elapsed() < Duration::from_secs(300)),
            "Wake claim expired"
        );
        let reply = store.call(device, v)?;
        claims.retain(|_, (_, id)| id != &key);
        return Ok(reply);
    }
    if v["op"] == "import_photo" {
        let name = field(v, "name")?;
        safe_name(name)?;
        anyhow::ensure!(!matches!(name, "home" | "clock"), "Built-in view");
        let bytes = STANDARD.decode(field(v, "data")?)?;
        anyhow::ensure!(bytes.starts_with(&[255, 216, 255]), "Expected a JPEG file");
        let dir = a.data.join("photos");
        fs::create_dir_all(&dir)?;
        let temp = dir.join(uuid::Uuid::new_v4().to_string());
        fs::write(&temp, bytes)?;
        fs::rename(temp, dir.join(format!("{name}.jpg")))?;
        return a.store.lock().unwrap().call(device,&json!({"op":"tools","name":"save_view","args":{"name":name,"spec":{"kind":"photo","asset":name}}}));
    }
    a.store.lock().unwrap().call(device, v)
}
async fn connection(a: App, s: UnixStream) -> Result<()> {
    let (read, mut write) = s.into_split();
    let mut read = BufReader::new(read);
    loop {
        let mut line = String::new();
        let n = (&mut read)
            .take((MAX_LINE + 1) as u64)
            .read_line(&mut line)
            .await?;
        if n == 0 {
            return Ok(());
        }
        if n > MAX_LINE {
            bail!("Line too large")
        }
        let result = async {
            let v: Value = serde_json::from_str(&line)?;
            let device = field(&v, "device")?;
            anyhow::ensure!(matches!(device, "pc" | "room" | "owner"), "Unknown device");
            call(&a, device, &v).await
        }
        .await;
        let msg = match result {
            Ok(v) => json!({"result":v}),
            Err(e) => json!({"error":format!("{e:#}")}),
        };
        write.write_all(msg.to_string().as_bytes()).await?;
        write.write_all(b"\n").await?;
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let data = data_dir();
    fs::create_dir_all(&data)?;
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
    let socket = socket_path();
    if socket.exists() {
        if UnixStream::connect(&socket).await.is_ok() {
            bail!("STapp already running")
        }
        fs::remove_file(&socket)?
    }
    let sock = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let store = Store::open(
        &data,
        env::var_os("STAPP_PROJECTS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.join("projects")),
    )?;
    let app = App {
        store: Arc::new(Mutex::new(store)),
        panel_key: env::var("STAPP_PANEL_KEY").unwrap_or_default(),
        owner: env::var("STAPP_OWNER").unwrap_or_default(),
        origin: env::var("STAPP_ORIGIN").unwrap_or_default(),
        data,
        claims: Default::default(),
        planner: planner::Client::from_env(),
    };
    let ipc = app.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = sock.accept().await {
            let a = ipc.clone();
            tokio::spawn(connection(a, s));
        }
    });
    let web = env::var("STAPP_WEB").unwrap_or_else(|_| "apps/kiosk/dist".into());
    anyhow::ensure!(
        Path::new(&web).join("index.html").is_file(),
        "Build the kiosk first"
    );
    let routes = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok"})) }),
        )
        .route("/api/display", get(snapshot).post(view))
        .route("/api/records/{id}", post(edit_record))
        .route("/api/planner", get(planner_read).post(planner_write))
        .route("/api/events", get(updates))
        .route("/api/frame", get(frame).post(upload_frame))
        .route("/api/asset/{kind}/{name}", get(asset))
        .fallback_service(ServeDir::new(web))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(app.clone(), headers))
        .with_state(app);
    let port = env::var("STAPP_PORT")
        .unwrap_or_else(|_| "18641".into())
        .parse::<u16>()?;
    axum::serve(
        tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .context("Bind loopback display listener")?,
        routes,
    )
    .await?;
    Ok(())
}
