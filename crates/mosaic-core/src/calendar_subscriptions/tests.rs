use super::*;
use std::future::Future;

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

fn subscription(id: &str) -> Subscription {
    Subscription {
        id: id.into(),
        name: "Original".into(),
        color: "blue".into(),
        visible: true,
        refresh_minutes: 30,
        etag: None,
        last_modified: None,
        last_success: None,
        last_error: None,
        cache_file: format!("{id}.ics"),
        validator_resource_hash: None,
        revision: 0,
        secret_id: None,
    }
}

fn migrate_for_root(store: &mut SubscriptionStore, root: &Path) -> String {
    let identity = crate::vault_id::identify(root).unwrap();
    let previous = crate::vault_id::migration_roots(root).unwrap();
    migrate_identity(store, &identity.id, root, &previous).unwrap();
    identity.id
}

#[test]
fn legacy_subscriptions_follow_move_even_after_another_service_identifies_vault() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("original");
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let original_id = crate::vault_id::identify(&root).unwrap().id;
    let mut legacy = subscription("retained-keychain-id");
    legacy.secret_id = Some("replacement-credential".into());
    let mut store = SubscriptionStore::default();
    store
        .vaults
        .insert(root.display().to_string(), vec![legacy.clone()]);
    let moved = root.with_file_name("moved");
    fs::rename(&root, &moved).unwrap();
    // History/planner activation may confirm the move before calendar metadata is loaded.
    crate::vault_id::identify(&moved).unwrap();
    let id = migrate_for_root(&mut store, &moved);
    assert_eq!(id, original_id);
    assert_eq!(store.vault_ids[&id], vec![legacy.clone()]);
    assert_eq!(store.vaults[&root.display().to_string()], vec![legacy]);
    store.vault_ids.get_mut(&id).unwrap().clear();
    let before = serde_json::to_value(&store).unwrap();
    assert_eq!(migrate_for_root(&mut store, &moved), id);
    assert_eq!(serde_json::to_value(&store).unwrap(), before);
}

#[test]
fn copies_and_reused_paths_do_not_inherit_claimed_calendar_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("original");
    fs::create_dir(&root).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let mut store = SubscriptionStore::default();
    store
        .vaults
        .insert(root.display().to_string(), vec![subscription("one")]);
    let id = migrate_for_root(&mut store, &root);
    let copy = root.with_file_name("copy");
    fs::create_dir_all(copy.join(".mosaic")).unwrap();
    fs::copy(
        root.join(crate::vault_id::FILE),
        copy.join(crate::vault_id::FILE),
    )
    .unwrap();
    let copy_id = migrate_for_root(&mut store, &copy);
    assert_ne!(id, copy_id);
    assert!(store.vault_ids[&copy_id].is_empty());
    assert!(crate::vault_id::migration_roots(&copy).unwrap().is_empty());
    fs::remove_file(root.join(crate::vault_id::FILE)).unwrap();
    let replacement_id = migrate_for_root(&mut store, &root);
    assert_ne!(replacement_id, id);
    assert!(store.vault_ids[&replacement_id].is_empty());
    assert_eq!(store.vault_ids[&id][0].id, "one");
}

#[test]
fn conflicting_paths_are_atomic_and_retryable_without_leaking_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let root = Path::new("/new");
    let previous = vec![PathBuf::from("/old")];
    let mut store = SubscriptionStore::default();
    store
        .vaults
        .insert("/new".into(), vec![subscription("one")]);
    store
        .vaults
        .insert("/old".into(), vec![subscription("two")]);
    Settings::try_update_in(dir.path(), |settings| {
        settings
            .other
            .insert(SETTINGS_KEY.into(), serde_json::to_value(&store)?);
        Ok(((), true))
    })
    .unwrap();
    let bytes = fs::read(dir.path().join("settings.json")).unwrap();
    let result = Settings::try_update_in(dir.path(), |settings| {
        mutate_settings(settings, |store| {
            migrate_identity(store, "id", root, &previous)
        })
    })
    .unwrap();
    let error = result.unwrap_err().to_string();
    assert!(!error.contains("/new") && !error.contains("/old"));
    assert_eq!(fs::read(dir.path().join("settings.json")).unwrap(), bytes);
    // Explicitly resolve the disagreement; both matching legacy records are claimed together.
    store
        .vaults
        .insert("/old".into(), vec![subscription("one")]);
    migrate_identity(&mut store, "id", root, &previous).unwrap();
    assert_eq!(store.vault_ids["id"].len(), 1);
    assert_eq!(store.migrated_paths.len(), 2);
}

#[test]
fn concurrent_migration_claims_legacy_path_only_once() {
    let dir = tempfile::tempdir().unwrap();
    Settings::try_update_in(dir.path(), |settings| {
        let mut store = SubscriptionStore::default();
        store
            .vaults
            .insert("/vault".into(), vec![subscription("one")]);
        settings
            .other
            .insert(SETTINGS_KEY.into(), serde_json::to_value(store)?);
        Ok(((), true))
    })
    .unwrap();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        for id in ["first", "second"] {
            let barrier = &barrier;
            let dir = dir.path();
            scope.spawn(move || {
                barrier.wait();
                Settings::try_update_in(dir, |settings| {
                    mutate_settings(settings, |store| {
                        migrate_identity(store, id, Path::new("/vault"), &[])
                    })
                })
                .unwrap()
                .unwrap();
            });
        }
    });
    let store = decode(&Settings::try_load_in(dir.path()).unwrap()).unwrap();
    assert_eq!(store.vault_ids.values().map(Vec::len).sum::<usize>(), 1);
    assert_eq!(store.migrated_paths.len(), 1);
}

#[test]
fn rejected_calendar_mutations_keep_error_codes_and_original_state() {
    let dir = tempfile::tempdir().unwrap();
    Settings::try_update_in(dir.path(), |settings| {
        let mut store = SubscriptionStore::default();
        store
            .vault_ids
            .insert("vault".into(), vec![subscription("one")]);
        settings
            .other
            .insert(SETTINGS_KEY.into(), serde_json::to_value(store)?);
        Ok(((), true))
    })
    .unwrap();
    let original = fs::read(dir.path().join("settings.json")).unwrap();
    let rejected: Result<()> = Settings::try_update_in(dir.path(), |settings| {
        mutate_settings(settings, |store| {
            store.vault_ids.clear();
            Err(Error::NotFound("calendar subscription/missing".into()))
        })
    })
    .unwrap();
    assert_eq!(rejected.unwrap_err().code(), "not_found");
    assert_eq!(
        fs::read(dir.path().join("settings.json")).unwrap(),
        original
    );

    let mut malformed = Settings::default();
    malformed
        .other
        .insert(SETTINGS_KEY.into(), serde_json::json!({"vaults": false}));
    let (result, changed) = mutate_settings(&mut malformed, |_| Ok(())).unwrap();
    assert!(!changed);
    assert_eq!(result.unwrap_err().code(), "invalid");
}

#[test]
fn old_metadata_keeps_its_existing_keychain_identity() {
    let mut value = serde_json::to_value(subscription("legacy")).unwrap();
    value.as_object_mut().unwrap().remove("revision");
    value.as_object_mut().unwrap().remove("secret_id");
    let decoded: Subscription = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.revision, 0);
    assert_eq!(
        decoded.secret_id.as_deref().unwrap_or(&decoded.id),
        "legacy"
    );
}

#[test]
fn delayed_refresh_preserves_rename_add_and_delete() {
    let before = subscription("one");
    let mut fetched = before.clone();
    fetched.last_success = Some("now".into());
    fetched.cache_file = "download.ics".into();
    fetched.validator_resource_hash = Some("resource".into());
    let mut store = SubscriptionStore::default();
    store.vault_ids.insert("vault".into(), vec![before.clone()]);
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| {
            barrier.wait(); // download started
            barrier.wait(); // user edits completed
            fetched
        });
        barrier.wait();
        store.vault_ids.get_mut("vault").unwrap()[0].name = "Renamed".into();
        store
            .vault_ids
            .get_mut("vault")
            .unwrap()
            .push(subscription("two"));
        barrier.wait();
        let fetched = worker.join().unwrap();
        assert!(merge_refresh(&mut store, "vault", &before, &fetched));
        assert_eq!(store.vault_ids["vault"][0].name, "Renamed");
        assert_eq!(
            store.vault_ids["vault"][0].last_success.as_deref(),
            Some("now")
        );
        // Conditional requests are only safe for the resource that produced the cache.
        assert_eq!(
            store.vault_ids["vault"][0]
                .validator_resource_hash
                .as_deref(),
            Some("resource")
        );
        assert_eq!(store.vault_ids["vault"][1].id, "two");
        store.vault_ids.get_mut("vault").unwrap().remove(0);
        assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
        assert_eq!(store.vault_ids["vault"].len(), 1);
    });
}

#[test]
fn replaced_feed_and_overlapping_refresh_reject_stale_downloads() {
    let before = subscription("one");
    let mut fetched = before.clone();
    fetched.cache_file = "download.ics".into();
    let mut store = SubscriptionStore::default();
    store.vault_ids.insert("vault".into(), vec![before.clone()]);
    assert!(merge_refresh(&mut store, "vault", &before, &fetched));
    assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
    store.vault_ids.get_mut("vault").unwrap()[0] = before.clone();
    invalidate_feed(&mut store.vault_ids.get_mut("vault").unwrap()[0]);
    assert!(!merge_refresh(&mut store, "vault", &before, &fetched));
    assert!(store.vault_ids["vault"][0].last_success.is_none());
}

#[test]
fn invalid_subscription_metadata_is_not_defaults() {
    let mut settings = Settings::default();
    settings
        .other
        .insert(SETTINGS_KEY.into(), serde_json::json!({"vaults": false}));
    assert!(decode(&settings).is_err());
}

#[test]
fn malformed_cached_calendars_keep_the_list_and_other_calendars_events() {
    let directory = tempfile::tempdir().unwrap();
    let base = Subscription {
        id: "good".into(),
        name: "Working calendar".into(),
        color: "#6477d4".into(),
        visible: true,
        refresh_minutes: 30,
        etag: None,
        last_modified: None,
        last_success: None,
        last_error: Some("Refresh unavailable; using cache".into()),
        revision: 0,
        secret_id: None,
        cache_file: "good.ics".into(),
        validator_resource_hash: None,
    };
    let mut items = vec![
        base.clone(),
        Subscription {
            id: "bad".into(),
            name: "Broken calendar".into(),
            revision: 0,
            secret_id: None,
            cache_file: "bad.ics".into(),
            last_error: None,
            ..base.clone()
        },
        Subscription {
            id: "corrupt".into(),
            name: "Corrupt calendar".into(),
            revision: 0,
            secret_id: None,
            cache_file: "corrupt.ics".into(),
            last_error: None,
            ..base
        },
    ];
    let good = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:good\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T100000Z\r\nSUMMARY:Working event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    fs::write(directory.path().join("good.ics"), good).unwrap();
    let bad = good.replace("DTSTART:20261103T090000Z", "DTSTART:not-a-date");
    fs::write(directory.path().join("bad.ics"), &bad).unwrap();
    fs::write(directory.path().join("corrupt.ics"), [0xff, 0xfe]).unwrap();
    let occurrences = cached_overlays(
        &mut items,
        directory.path(),
        "2026-11-03",
        "2026-11-03",
        "UTC",
    );
    assert_eq!(occurrences.len(), 1);
    assert_eq!(occurrences[0].title, "Working event");
    assert_eq!(occurrences[0].source_id, "good");
    assert_eq!(
        items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["good", "bad", "corrupt"]
    );
    assert_eq!(
        items[0].last_error.as_deref(),
        Some("Refresh unavailable; using cache")
    );
    assert!(items[1].last_error.as_deref().unwrap().contains("date"));
    assert!(items[2].last_error.is_some());
    assert!(validate_ical(&bad, "UTC").is_err());
    assert_eq!(validate_ical(good, "UTC").unwrap(), 1);
}

#[test]
fn metadata_never_serializes_a_feed_url() {
    let mut subscription = Subscription {
        id: "id".into(),
        name: "Team".into(),
        color: "#5b8def".into(),
        visible: true,
        refresh_minutes: 30,
        etag: None,
        last_modified: None,
        last_success: None,
        last_error: None,
        revision: 0,
        secret_id: None,
        cache_file: "id.ics".into(),
        validator_resource_hash: None,
    };
    let encoded = serde_json::to_string(&subscription).unwrap();
    assert!(!encoded.contains("url"));
    assert!(!encoded.contains("https"));
    subscription.etag = Some("old etag".into());
    subscription.last_modified = Some("old modified".into());
    subscription.last_success = Some("2026-11-01T00:00:00Z".into());
    subscription.last_error = Some("old error".into());
    invalidate_feed(&mut subscription);
    assert_ne!(subscription.cache_file, "id.ics");
    assert_eq!(
        std::path::Path::new(&subscription.cache_file)
            .components()
            .count(),
        1
    );
    assert!(subscription.etag.is_none());
    assert!(subscription.last_modified.is_none());
    assert!(subscription.last_success.is_none());
    assert!(subscription.last_error.is_none());
    assert_eq!(subscription.id, "id");
    assert_eq!(subscription.name, "Team");
}

#[test]
fn cache_paths_are_fixed_basenames() {
    let path = std::path::Path::new("calendar-cache").join("abc.ics");
    assert_eq!(path.file_name().unwrap(), "abc.ics");
}

#[test]
fn webcal_is_normalized_and_unsafe_schemes_are_rejected() {
    assert_eq!(
        normalized_url("webcal://calendar.example/team.ics")
            .unwrap()
            .as_str(),
        "https://calendar.example/team.ics"
    );
    assert!(normalized_url("http://calendar.example/team.ics").is_err());
    assert!(normalized_url("file:///private/team.ics").is_err());
}

mod download_tests {
    use super::super::*;
    use super::block_on;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Opt-in provider check. Keep private URLs and event contents out of fixtures and logs.
    #[test]
    #[ignore = "requires MOSAIC_TEST_CALENDAR_URL and network access"]
    fn live_calendar_subscription_download() {
        let input = std::env::var("MOSAIC_TEST_CALENDAR_URL")
            .expect("set MOSAIC_TEST_CALENDAR_URL to the subscription or calendar page URL");
        let original = reqwest::Url::parse(&input).expect("valid calendar URL");
        let normalized = normalized_url(&input).expect("supported calendar URL");
        let client = crate::http::client(Duration::from_secs(15)).unwrap();
        block_on(async {
            if original != normalized {
                match client.get(original).send().await {
                    Ok(response) => {
                        eprintln!("Original calendar page HTTP {}", response.status().as_u16())
                    }
                    Err(_) => eprintln!("Original calendar page could not be reached"),
                }
            }
            let feed = download_feed(&client, normalized, &Validators::default())
                .await
                .expect("calendar download succeeds")
                .expect("initial request downloads a calendar");
            let count = validate_ical(&feed.content, "Europe/Zurich")
                .expect("downloaded calendar can be parsed");
            let warnings = ical_warnings(&feed.content, "Europe/Zurich").unwrap();
            let mut store = crate::planner::PlannerStore::in_memory().unwrap();
            let preview = store
                .preview_ical_import("live-check", &feed.content, "Europe/Zurich")
                .expect("downloaded calendar can be previewed");
            let today = Utc::now().date_naive();
            let through = today + chrono::Duration::days(31);
            let occurrences = overlay_occurrences(
                &feed.content,
                "live-check",
                "Live check",
                None,
                &today.to_string(),
                &through.to_string(),
                "Europe/Zurich",
            )
            .expect("downloaded calendar can be expanded");
            let selected = preview
                .candidates
                .iter()
                .map(|event| event.key.clone())
                .collect::<Vec<_>>();
            let imported = store
                .import_ical(&preview, &selected, false)
                .expect("all readable events can be imported into a temporary calendar");
            assert_eq!(imported.imported_event_ids.len(), preview.candidates.len());
            let local = store
                .calendar_range(&today.to_string(), &through.to_string())
                .expect("imported events can be expanded");
            assert_eq!(
                local.events.len(),
                occurrences.len(),
                "import preserves the overlay's occurrences"
            );
            let exported = store
                .export_ical()
                .expect("imported calendar can be exported");
            let roundtrip = overlay_occurrences(
                &exported,
                "roundtrip",
                "Round trip",
                None,
                &today.to_string(),
                &through.to_string(),
                "Europe/Zurich",
            )
            .expect("exported calendar can be read again");
            assert_eq!(
                roundtrip.len(),
                local.events.len(),
                "export preserves the imported occurrences"
            );
            eprintln!(
                "Calendar download: {} bytes, {count} parsed events, {} imported events, {} warnings, {} occurrences in the next month; import/export verified",
                feed.content.len(),
                imported.imported_event_ids.len(),
                warnings.len(),
                occurrences.len()
            );
        });
    }

    fn serve(responses: Vec<String>) -> (reqwest::Url, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = reqwest::Url::parse(&format!(
            "http://{}/calendar.ics",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 1024];
                while !bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let read = stream.read(&mut chunk).unwrap();
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..read]);
                }
                requests.push(String::from_utf8(bytes).unwrap());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (url, thread)
    }

    #[test]
    fn published_outlook_html_links_resolve_without_requesting_the_html_page() {
        for host in [
            "outlook.office365.com",
            "outlook.office.com",
            "outlook.live.com",
        ] {
            let url = normalized_url(&format!(
                "https://{host}/owa/calendar/secret/calendar.html?x=1"
            ))
            .unwrap();
            assert_eq!(url.path(), "/owa/calendar/secret/calendar.ics");
            assert_eq!(url.query(), Some("x=1"));
        }
        assert_eq!(
            normalized_url("WEBCAL://example.test/feed.ics")
                .unwrap()
                .scheme(),
            "https"
        );
        assert_eq!(
            normalized_url("https://example.test/calendar.html")
                .unwrap()
                .path(),
            "/calendar.html"
        );
    }

    #[test]
    fn calendar_pages_resolve_declared_relative_and_webcal_links() {
        let page = reqwest::Url::parse("https://example.test/calendars/view.html").unwrap();
        for (html, expected) in [
            (
                r#"<link rel="alternate" type="text/calendar" href="../download?token=a&amp;b=2">"#,
                "https://example.test/download?token=a&b=2",
            ),
            (
                r#"<base href="/shared/"><a href="team.ics">Subscribe</a>"#,
                "https://example.test/shared/team.ics",
            ),
            (
                r#"<a href="webcal://example.test/private.ics">Subscribe</a>"#,
                "https://example.test/private.ics",
            ),
            (
                r#"<a href="webcal://example.test/opaque-token">Subscribe</a>"#,
                "https://example.test/opaque-token",
            ),
            (
                r#"<link type="application/ics" href="/download?id=1">"#,
                "https://example.test/download?id=1",
            ),
            (
                r#"<a href="team.ics">A</a><link type="text/calendar" href="team.ics">"#,
                "https://example.test/calendars/team.ics",
            ),
        ] {
            assert_eq!(html_feed_url(html, &page).unwrap().as_str(), expected);
        }
        assert!(
            html_feed_url("<html>Sign in to view this calendar</html>", &page)
                .unwrap_err()
                .to_string()
                .contains("ICS or webcal")
        );
        assert!(
            html_feed_url(
                r#"<a href="one.ics">One</a><a href="two.ics">Two</a>"#,
                &page
            )
            .unwrap_err()
            .to_string()
            .contains("several")
        );
        assert!(html_feed_url(r#"<a href="http://example.test/team.ics">HTTP</a><a href="file:///private/feed.ics">Local</a>"#, &page).is_err());
    }

    #[test]
    fn feed_decoding_handles_declared_encodings_and_utf16_boms() {
        assert_eq!(
            decode_feed(b"SUMMARY:Caf\xe9", "text/calendar; charset=iso-8859-1").unwrap(),
            "SUMMARY:Café"
        );
        let utf16 = [
            vec![0xff, 0xfe],
            "BEGIN:VCALENDAR"
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect(),
        ]
        .concat();
        assert_eq!(
            decode_feed(&utf16, "text/calendar").unwrap(),
            "BEGIN:VCALENDAR"
        );
        assert!(decode_feed(&[0xff, 0x80], "text/calendar; charset=utf-8").is_err());
    }

    #[test]
    fn http_417_retries_once_with_compatible_headers_and_downloads_ics() {
        let content = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
        let (url, server) = serve(vec![
            "HTTP/1.1 417 Expectation Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .into(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/calendar\r\nETag: test-tag\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}",
                content.len()
            ),
        ]);
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .user_agent("Mosaic")
            .build()
            .unwrap();
        let feed = block_on(download_feed(&client, url.clone(), &Validators::default()))
            .unwrap()
            .unwrap();
        assert_eq!(feed.content, content);
        assert_eq!(feed.etag.as_deref(), Some("test-tag"));
        assert_eq!(feed.url_hash, url_hash(&url));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("text/calendar"));
        assert!(requests[1].contains("Mozilla/5.0"));
        assert!(
            requests
                .iter()
                .all(|request| !request.to_ascii_lowercase().contains("\r\nexpect:"))
        );
    }

    #[test]
    fn conditional_requests_only_send_validators_to_the_cached_resource() {
        let (url, server) = serve(vec![
            "HTTP/1.1 304 Not Modified\r\nConnection: close\r\n\r\n".into(),
        ]);
        let item = Validators {
            etag: Some("cached-tag".into()),
            last_modified: Some("Wed, 04 Nov 2026 10:00:00 GMT".into()),
            resource_hash: Some(url_hash(&url)),
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        assert!(
            block_on(download_feed(&client, url, &item))
                .unwrap()
                .is_none()
        );
        let requests = server.join().unwrap();
        assert!(requests[0].contains("if-none-match: cached-tag"));
        assert!(requests[0].contains("if-modified-since:"));

        let body = "BEGIN:VCALENDAR\nEND:VCALENDAR\n";
        let (url, server) = serve(vec![format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )]);
        assert!(
            block_on(download_feed(&client, url, &item))
                .unwrap()
                .is_some()
        );
        assert!(!server.join().unwrap()[0].contains("if-none-match"));
    }

    #[test]
    fn failed_and_oversized_responses_return_errors_without_echoing_private_urls() {
        for response in [
            "HTTP/1.1 417 Expectation Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_FEED_BYTES + 1
            ),
        ] {
            let responses = if response.contains("417") {
                vec![response.clone(), response]
            } else {
                vec![response]
            };
            let (mut url, server) = serve(responses);
            url.set_query(Some("secret=private-token"));
            let client = reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap();
            let error = block_on(download_feed(&client, url, &Validators::default()))
                .err()
                .unwrap()
                .to_string();
            assert!(!error.contains("private-token"));
            assert!(error.contains("417") || error.contains("10 MB"));
            server.join().unwrap();
        }
    }
}

/// The service end to end, with an in-memory secret store and a scripted feed source.
mod service_tests {
    use super::super::testing::{MemorySecrets, ScriptedFetcher};
    use super::super::*;
    use super::block_on;

    const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T093000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const URL: &str = "webcal://calendar.example/team.ics?token=private-token";

    fn feed(content: &str, etag: &str) -> Result<Option<DownloadedFeed>> {
        Ok(Some(DownloadedFeed {
            content: content.into(),
            etag: Some(etag.into()),
            last_modified: None,
            url_hash: "resource".into(),
        }))
    }

    struct Fixture {
        dir: tempfile::TempDir,
        service: CalendarSubscriptions<MemorySecrets, ScriptedFetcher>,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            fs::create_dir(dir.path().join("vault")).unwrap();
            let service = CalendarSubscriptions::new(
                dir.path().join("cache"),
                MemorySecrets::default(),
                ScriptedFetcher::default(),
            )
            .with_settings_dir(dir.path().join("settings"));
            Self { dir, service }
        }
        fn root(&self) -> PathBuf {
            self.dir.path().join("vault")
        }
        fn respond(&self, response: Result<Option<DownloadedFeed>>) {
            self.service
                .fetcher
                .responses
                .lock()
                .unwrap()
                .push_back(response);
        }
        fn calls(&self) -> Vec<(String, Validators)> {
            std::mem::take(&mut self.service.fetcher.calls.lock().unwrap())
        }
        fn secrets(&self) -> HashMap<String, String> {
            self.service.secrets.0.lock().unwrap().clone()
        }
        fn cache_files(&self) -> Vec<String> {
            let mut files: Vec<String> = fs::read_dir(self.dir.path().join("cache"))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            files.sort();
            files
        }
        fn add(&self) -> SubscriptionView {
            self.respond(feed(FEED, "first"));
            let root = self.root();
            block_on(
                self.service
                    .add(|| Ok(root), " Team ", URL, "#5b8def".into(), 30),
            )
            .unwrap()
        }
    }

    #[test]
    fn add_downloads_once_and_stores_metadata_without_the_url() {
        let fixture = Fixture::new();
        let view = fixture.add();
        assert_eq!(view.name, "Team");
        assert!(view.visible && view.has_cache && view.last_success.is_some());
        assert_eq!(view.last_error, None);
        let calls = fixture.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].0,
            "https://calendar.example/team.ics?token=private-token"
        );
        assert_eq!(calls[0].1, Validators::default());
        assert_eq!(
            fixture.secrets().get(&view.id).map(String::as_str),
            Some("https://calendar.example/team.ics?token=private-token")
        );
        let settings =
            fs::read_to_string(fixture.dir.path().join("settings/settings.json")).unwrap();
        assert!(settings.contains(SETTINGS_KEY));
        assert!(!settings.contains("private-token") && !settings.contains("calendar.example"));
        let listed = fixture.service.list(&fixture.root()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, view.id);
        assert_eq!(fixture.cache_files().len(), 1);
    }

    #[test]
    fn subscriptions_belong_to_one_vault() {
        let fixture = Fixture::new();
        fixture.add();
        let other = fixture.dir.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(fixture.service.list(&other).unwrap().is_empty());
        assert_eq!(fixture.service.list(&fixture.root()).unwrap().len(), 1);
    }

    #[test]
    fn invalid_arguments_are_reported_before_the_vault_is_resolved() {
        let fixture = Fixture::new();
        let no_vault = || Err(Error::Invalid("no vault is open".into()));
        for (name, url, minutes) in [
            ("", URL, 30),
            ("Team", URL, 4),
            ("Team", "http://calendar.example/team.ics", 30),
        ] {
            let error = block_on(
                fixture
                    .service
                    .add(no_vault, name, url, "c".into(), minutes),
            )
            .unwrap_err()
            .to_string();
            assert!(!error.contains("no vault"), "{error}");
        }
        let error = fixture
            .service
            .update(no_vault, "id", " ", "c".into(), true, 30, None)
            .unwrap_err()
            .to_string();
        assert!(error.contains("invalid calendar subscription settings"));
        assert!(fixture.calls().is_empty() && fixture.secrets().is_empty());
    }

    #[test]
    fn a_failed_first_download_still_adds_the_subscription() {
        let fixture = Fixture::new();
        fixture.respond(Err(Error::Invalid(
            "calendar feed could not be reached".into(),
        )));
        let root = fixture.root();
        let view = block_on(
            fixture
                .service
                .add(|| Ok(root), "Team", URL, "c".into(), 30),
        )
        .unwrap();
        assert!(!view.has_cache && view.last_success.is_none());
        assert_eq!(
            view.last_error.as_deref(),
            Some("calendar feed could not be reached")
        );
        assert_eq!(fixture.service.list(&fixture.root()).unwrap().len(), 1);
    }

    #[test]
    fn refresh_skips_feeds_that_are_not_due_and_revalidates_a_good_cache() {
        let fixture = Fixture::new();
        let view = fixture.add();
        fixture.calls();
        let listed = block_on(fixture.service.refresh(&fixture.root(), false)).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(fixture.calls().is_empty(), "a fresh feed is not due");

        let cache = fixture.cache_files();
        fixture.respond(Ok(None));
        let listed = block_on(fixture.service.refresh(&fixture.root(), true)).unwrap();
        let calls = fixture.calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].1,
            Validators {
                etag: Some("first".into()),
                last_modified: None,
                resource_hash: Some("resource".into()),
            }
        );
        assert_eq!(listed[0].id, view.id);
        assert!(listed[0].has_cache && listed[0].last_success.is_some());
        assert_eq!(fixture.cache_files(), cache, "not modified keeps the cache");
    }

    #[test]
    fn a_corrupt_or_missing_cache_drops_conditional_validators() {
        let fixture = Fixture::new();
        fixture.add();
        fixture.calls();
        let cache = fixture
            .dir
            .path()
            .join("cache")
            .join(&fixture.cache_files()[0]);
        fs::write(&cache, "not a calendar").unwrap();
        fixture.respond(feed(FEED, "second"));
        block_on(fixture.service.refresh(&fixture.root(), true)).unwrap();
        let calls = fixture.calls();
        assert_eq!(calls[0].1.resource_hash, None);
        assert_eq!(calls[0].1.etag.as_deref(), Some("first"));
        // The new download replaced the old cache file.
        assert_eq!(fixture.cache_files().len(), 1);
        assert!(!cache.exists());

        let cache = fixture
            .dir
            .path()
            .join("cache")
            .join(&fixture.cache_files()[0]);
        fs::remove_file(&cache).unwrap();
        fixture.respond(feed(FEED, "third"));
        let listed = block_on(fixture.service.refresh(&fixture.root(), true)).unwrap();
        assert_eq!(fixture.calls()[0].1.resource_hash, None);
        assert!(listed[0].has_cache);
    }

    #[test]
    fn a_failed_refresh_keeps_the_cache_and_reports_the_error() {
        let fixture = Fixture::new();
        fixture.add();
        let cache = fixture.cache_files();
        fixture.respond(Err(Error::Invalid(
            "calendar feed returned HTTP 500".into(),
        )));
        let listed = block_on(fixture.service.refresh(&fixture.root(), true)).unwrap();
        assert!(listed[0].has_cache);
        assert_eq!(
            listed[0].last_error.as_deref(),
            Some("calendar feed returned HTTP 500")
        );
        assert_eq!(fixture.cache_files(), cache);
        // An invalid download never replaces the cache either.
        fixture.respond(feed(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:bad\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "bad",
        ));
        let listed = block_on(fixture.service.refresh(&fixture.root(), true)).unwrap();
        assert!(listed[0].last_error.is_some());
        assert_eq!(fixture.cache_files(), cache);
    }

    #[test]
    fn hidden_feeds_refresh_only_when_forced() {
        let fixture = Fixture::new();
        let view = fixture.add();
        let root = fixture.root();
        fixture
            .service
            .update(|| Ok(root), &view.id, "Team", "c".into(), false, 5, None)
            .unwrap();
        fixture.calls();
        block_on(fixture.service.refresh(&fixture.root(), false)).unwrap();
        assert!(fixture.calls().is_empty());
    }

    #[test]
    fn update_replaces_the_feed_credentials_and_cache_atomically() {
        let fixture = Fixture::new();
        let view = fixture.add();
        let root = fixture.root();
        let kept = fixture
            .service
            .update(
                || Ok(root.clone()),
                &view.id,
                " Renamed ",
                "red".into(),
                true,
                60,
                Some(" ".into()),
            )
            .unwrap();
        assert_eq!(
            (
                kept.name.as_str(),
                kept.color.as_str(),
                kept.refresh_minutes
            ),
            ("Renamed", "red", 60)
        );
        assert!(kept.has_cache && kept.last_success.is_some());
        assert_eq!(fixture.secrets().len(), 1);

        let replaced = fixture
            .service
            .update(
                || Ok(root.clone()),
                &view.id,
                "Renamed",
                "red".into(),
                true,
                60,
                Some("https://calendar.example/other.ics".into()),
            )
            .unwrap();
        assert!(!replaced.has_cache && replaced.last_success.is_none());
        assert!(
            fixture.cache_files().is_empty(),
            "the old feed's cache is removed"
        );
        let secrets = fixture.secrets();
        assert_eq!(secrets.len(), 1);
        assert!(
            !secrets.contains_key(&view.id),
            "the old credential is deleted"
        );
        assert_eq!(
            secrets.values().next().map(String::as_str),
            Some("https://calendar.example/other.ics")
        );
        // The next refresh reads the replacement credential.
        fixture.calls();
        fixture.respond(feed(FEED, "other"));
        block_on(fixture.service.refresh(&fixture.root(), false)).unwrap();
        assert_eq!(fixture.calls()[0].0, "https://calendar.example/other.ics");

        let missing = fixture.service.update(
            || Ok(root.clone()),
            "missing",
            "Name",
            "c".into(),
            true,
            30,
            Some("https://calendar.example/third.ics".into()),
        );
        assert_eq!(missing.unwrap_err().code(), "not_found");
        assert_eq!(
            fixture.secrets(),
            secrets,
            "a staged credential is rolled back"
        );
    }

    #[test]
    fn remove_forgets_the_credential_and_the_cache() {
        let fixture = Fixture::new();
        let view = fixture.add();
        fixture.service.remove(&fixture.root(), &view.id).unwrap();
        assert!(fixture.service.list(&fixture.root()).unwrap().is_empty());
        assert!(fixture.secrets().is_empty());
        assert!(fixture.cache_files().is_empty());
        assert_eq!(
            fixture
                .service
                .remove(&fixture.root(), &view.id)
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    #[test]
    fn overlay_range_reads_visible_cached_feeds_without_downloading() {
        let fixture = Fixture::new();
        let view = fixture.add();
        fixture.calls();
        let range = fixture
            .service
            .overlay_range(&fixture.root(), "2026-11-03", "2026-11-03", "UTC")
            .unwrap();
        assert_eq!(range.subscriptions.len(), 1);
        assert_eq!(range.occurrences.len(), 1);
        assert_eq!(range.occurrences[0].title, "Standup");
        assert_eq!(range.occurrences[0].source_id, view.id);
        let empty = fixture
            .service
            .overlay_range(&fixture.root(), "2026-11-04", "2026-11-04", "UTC")
            .unwrap();
        assert!(empty.occurrences.is_empty());
        let root = fixture.root();
        fixture
            .service
            .update(|| Ok(root), &view.id, "Team", "c".into(), false, 30, None)
            .unwrap();
        let hidden = fixture
            .service
            .overlay_range(&fixture.root(), "2026-11-03", "2026-11-03", "UTC")
            .unwrap();
        assert!(hidden.occurrences.is_empty());
        assert_eq!(hidden.subscriptions.len(), 1);
        assert!(fixture.calls().is_empty());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn without_the_macos_keychain_nothing_is_subscribed() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("vault")).unwrap();
        let service = CalendarSubscriptions::new(
            dir.path().join("cache"),
            Keychain,
            ScriptedFetcher::default(),
        )
        .with_settings_dir(dir.path().join("settings"));
        let root = dir.path().join("vault");
        let error = block_on(service.add(|| Ok(root.clone()), "Team", URL, "c".into(), 30))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Keychain"));
        assert!(service.list(&root).unwrap().is_empty());
    }
}

/// The workspace-bound service agents use: writes need the `subscriptions:` scope under an
/// allowlist, and partial updates keep the other fields.
mod workspace_tests {
    use super::super::testing::{MemorySecrets, ScriptedFetcher};
    use super::super::*;
    use super::block_on;
    use crate::api::Workspace;
    use crate::history::Source;

    const FEED: &str = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:standup\r\nDTSTART:20261103T090000Z\r\nDTEND:20261103T093000Z\r\nSUMMARY:Standup\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const URL: &str = "https://calendar.example/team.ics?token=private-token";

    fn feed() -> Result<Option<DownloadedFeed>> {
        Ok(Some(DownloadedFeed {
            content: FEED.into(),
            etag: None,
            last_modified: None,
            url_hash: "resource".into(),
        }))
    }

    fn setup() -> (
        tempfile::TempDir,
        CalendarSubscriptions<MemorySecrets, ScriptedFetcher>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("vault/Daily")).unwrap();
        let service = CalendarSubscriptions::new(
            dir.path().join("cache"),
            MemorySecrets::default(),
            ScriptedFetcher::default(),
        )
        .with_settings_dir(dir.path().join("settings"));
        (dir, service)
    }

    fn agent(dir: &tempfile::TempDir, may_change: &[&str]) -> Workspace {
        Workspace::open(dir.path().join("vault"))
            .unwrap()
            .with_source(Source::Agent)
            .with_change_allowlist(may_change.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn writes_are_refused_without_the_scope_before_anything_is_touched() {
        let (dir, service) = setup();
        let ws = agent(&dir, &["Daily"]);
        let subs = service.for_workspace(&ws);
        let denied = |result: Result<()>| match result {
            Err(Error::Denied(message)) => {
                assert!(message.contains("`subscriptions:`"), "{message}");
                assert!(message.contains("calendar subscriptions"), "{message}");
            }
            other => panic!("expected a refusal, got {other:?}"),
        };
        denied(block_on(subs.add("Team", URL, "#6477d4".into(), 30)).map(|_| ()));
        denied(
            subs.update("missing", SubscriptionPatch::default())
                .map(|_| ()),
        );
        denied(subs.remove("missing"));
        denied(block_on(subs.refresh(true)).map(|_| ()));
        assert!(service.secrets.all().is_empty());
        assert!(service.fetcher.take_calls().is_empty());
        assert!(!dir.path().join("settings/settings.json").exists());
        // Reads are never refused.
        assert!(subs.list().unwrap().is_empty());
        assert!(
            subs.overlay_range("2026-11-01", "2026-11-30", "UTC")
                .unwrap()
                .occurrences
                .is_empty()
        );
    }

    #[test]
    fn the_scope_allows_every_write() {
        let (dir, service) = setup();
        let ws = agent(&dir, &["Daily", "Subscriptions:"]);
        let subs = service.for_workspace(&ws);
        service.fetcher.respond(feed());
        let added = block_on(subs.add("Team", URL, "#6477d4".into(), 30)).unwrap();
        assert!(added.has_cache);
        let range = subs
            .overlay_range("2026-11-01", "2026-11-30", "UTC")
            .unwrap();
        assert_eq!(range.occurrences.len(), 1);
        assert_eq!(range.occurrences[0].title, "Standup");
        service.fetcher.respond(Ok(None));
        assert_eq!(block_on(subs.refresh(true)).unwrap().len(), 1);
        let changed = subs
            .update(
                &added.id,
                SubscriptionPatch {
                    visible: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!changed.visible);
        subs.remove(&added.id).unwrap();
        assert!(subs.list().unwrap().is_empty());
        assert!(service.secrets.all().is_empty());
    }

    #[test]
    fn a_patch_changes_only_the_given_fields() {
        let (dir, service) = setup();
        service.fetcher.respond(feed());
        let root = dir.path().join("vault");
        let added =
            block_on(service.add(|| Ok(root.clone()), "Team", URL, "#6477d4".into(), 30)).unwrap();
        // Another process renames it in between; a patch of the colour keeps the new name.
        service
            .update(
                || Ok(root.clone()),
                &added.id,
                "Renamed",
                "#6477d4".into(),
                true,
                30,
                None,
            )
            .unwrap();
        let patched = service
            .patch(
                || Ok(root.clone()),
                &added.id,
                SubscriptionPatch {
                    color: Some("#ff0000".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(patched.name, "Renamed");
        assert_eq!(patched.color, "#ff0000");
        assert!(patched.visible && patched.has_cache);
        assert_eq!(patched.refresh_minutes, 30);
        for bad in [
            SubscriptionPatch {
                name: Some("  ".into()),
                ..Default::default()
            },
            SubscriptionPatch {
                refresh_minutes: Some(4),
                ..Default::default()
            },
        ] {
            assert!(matches!(
                service.patch(|| Ok(root.clone()), &added.id, bad),
                Err(Error::Invalid(_))
            ));
        }
        // A new URL replaces the feed: its secret, and the cache is dropped until the next refresh.
        let moved = service
            .patch(
                || Ok(root.clone()),
                &added.id,
                SubscriptionPatch {
                    url: Some("https://calendar.example/other.ics".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!moved.has_cache);
        assert_eq!(moved.name, "Renamed");
        let secrets: Vec<String> = service.secrets.all().into_values().collect();
        assert_eq!(secrets, ["https://calendar.example/other.ics"]);
    }
}
