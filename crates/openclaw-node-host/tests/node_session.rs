use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    CommandRuntime, ConnectAuth, HandlerError, NodeClient, NodeClientConfig, NodeConnectOptions,
    NodeIdentity, NodeProtocolVersion,
};
use serde_json::{json, Value};
use std::{
    io,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn public_runtime_completes_allowed_work_and_suppresses_wire_cancelled_effects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancelled_handler_entered = Arc::new(Notify::new());
    let server_handler_entered = Arc::clone(&cancelled_handler_entered);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        assert_eq!(connect["params"]["client"]["mode"], "node");
        assert_eq!(connect["params"]["role"], "node");
        assert_eq!(connect["params"]["commands"], json!(["example.status"]));
        assert_eq!(connect["params"]["device"]["nonce"], "node-nonce");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.invoke.request",
                "payload":{"id":"allowed","nodeId":"node-1","command":"example.status",
                    "paramsJSON":"{\"verbose\":true}",
                    "sessionKey":"agent:main:main"}
            }),
        )
        .await;
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["id"], "allowed");
        assert_eq!(result["params"]["payload"], json!({"ready":true}));
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":result["id"], "ok":true, "payload":{"accepted":true}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.invoke.request",
                "payload":{"id":"cancelled","nodeId":"node-1","command":"example.status",
                    "paramsJSON":"{\"verbose\":false}"}
            }),
        )
        .await;
        server_handler_entered.notified().await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.invoke.cancel",
                "payload":{"invokeId":"cancelled","nodeId":"node-1"}
            }),
        )
        .await;
        let cancelled = receive_json(&mut socket).await;
        assert_eq!(cancelled["method"], "node.invoke.result");
        assert_eq!(cancelled["params"]["id"], "cancelled");
        assert_eq!(cancelled["params"]["ok"], false);
        assert_eq!(cancelled["params"]["error"]["code"], "CANCELLED_BY_GATEWAY");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":cancelled["id"], "ok":true, "payload":{"accepted":true}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let native_effects = Arc::new(AtomicUsize::new(0));
    let handler_effects = Arc::clone(&native_effects);
    let handler_entered = Arc::clone(&cancelled_handler_entered);
    let runtime = CommandRuntime::builder()
        .command("example.status", move |context| {
            let effects = Arc::clone(&handler_effects);
            let entered = Arc::clone(&handler_entered);
            async move {
                assert_eq!(
                    context.invocation.session_key.as_deref(),
                    (context.invocation.id == "allowed").then_some("agent:main:main")
                );
                if context.invocation.id == "cancelled" {
                    entered.notify_one();
                    context.cancellation.cancelled().await;
                    return Err(HandlerError::new(
                        "CANCELLED_BY_GATEWAY",
                        "Gateway cancelled before native effects",
                    ));
                }
                assert_eq!(context.invocation.params, json!({"verbose": true}));
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"ready": true}))
            }
        })
        .build()
        .unwrap();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        |challenge| async move {
            assert_eq!(challenge.nonce, "node-nonce");
            Ok::<_, io::Error>(
                NodeConnectOptions::new("test", "linux")
                    .command("example.status")
                    .activate()
                    .auth(ConnectAuth::token("test-token"))
                    .identity(NodeIdentity::from_secret_bytes([7; 32])),
            )
        },
    )
    .await
    .unwrap();
    assert!(session.is_activated());
    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
    assert_eq!(native_effects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn runtime_rejects_buffered_invocation_after_session_retirement_is_requested() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request",
                "payload":{"id":"retired","nodeId":"node-1","command":"example.status"}}),
        )
        .await;
        let barrier = receive_json(&mut socket).await;
        assert_eq!(barrier["method"], "test.buffered");
        send_json(
            &mut socket,
            json!({"type":"res","id":barrier["id"],"ok":true,"payload":null}),
        )
        .await;
        while let Some(message) = socket.next().await {
            let message = message.unwrap();
            if message.is_close() {
                break;
            }
            if let Message::Text(text) = message {
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                send_json(
                    &mut socket,
                    json!({"type":"res","id":request["id"],"ok":true,"payload":null}),
                )
                .await;
            }
        }
    });

    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        |_challenge| async move {
            Ok::<_, io::Error>(
                NodeConnectOptions::new("test", "linux")
                    .command("example.status")
                    .activate()
                    .auth(ConnectAuth::token("test-token"))
                    .identity(NodeIdentity::from_secret_bytes([7; 32])),
            )
        },
    )
    .await
    .unwrap();
    session.request("test.buffered", Value::Null).await.unwrap();
    session.close().await;
    assert!(session.is_retired());

    let handler_ran = Arc::new(AtomicBool::new(false));
    let handler_state = Arc::clone(&handler_ran);
    let runtime = CommandRuntime::builder()
        .command("example.status", move |_context| {
            let handler_state = Arc::clone(&handler_state);
            handler_state.store(true, Ordering::SeqCst);
            async { Ok(Value::Null) }
        })
        .build()
        .unwrap();

    assert!(runtime.run(session).await.is_err());
    assert!(!handler_ran.load(Ordering::SeqCst));
    server.await.unwrap();
}

#[tokio::test]
async fn node_protocol_fallback_uses_fresh_legacy_connect_material_and_recovers_to_v4() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut current, current_connect) =
            accept_node_connect(&listener, "nonce-v4", 1_700_000_000_123).await;
        assert_current_connect(&current_connect, "nonce-v4");
        send_json(
            &mut current,
            json!({
                "type":"res", "id":current_connect["id"], "ok":false,
                "error":{
                    "code":"INVALID_REQUEST",
                    "message":"protocol mismatch",
                    "details":{"expectedProtocol":3}
                }
            }),
        )
        .await;

        let (mut legacy, legacy_connect) =
            accept_node_connect(&listener, "nonce-v3", 1_700_000_000_456).await;
        assert_legacy_connect(&legacy_connect, "nonce-v3");
        assert_ne!(
            current_connect["params"]["device"]["signature"],
            legacy_connect["params"]["device"]["signature"]
        );
        send_json(
            &mut legacy,
            json!({
                "type":"res", "id":legacy_connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":3}
            }),
        )
        .await;
        send_json(
            &mut legacy,
            json!({
                "type":"event", "event":"node.invoke.request",
                "payload":{
                    "id":"invoke-v3",
                    "nodeId":"node-1",
                    "command":"example.status",
                    "paramsJSON":"{\"verbose\":true}"
                }
            }),
        )
        .await;
        while let Some(Ok(message)) = legacy.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }

        let (mut upgraded, upgraded_connect) =
            accept_node_connect(&listener, "nonce-v4-again", 1_700_000_000_789).await;
        assert_current_connect(&upgraded_connect, "nonce-v4-again");
        send_json(
            &mut upgraded,
            json!({
                "type":"res", "id":upgraded_connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
    });

    let connect = || {
        NodeClient::connect(
            NodeClientConfig::new(format!("ws://{address}")),
            |_challenge| async move {
                Ok::<_, io::Error>(
                    NodeConnectOptions::new("test", "macos")
                        .device_family("Mac")
                        .command("example.status")
                        .activate()
                        .identity(NodeIdentity::from_secret_bytes([7; 32])),
                )
            },
        )
    };
    let legacy = connect().await.unwrap();
    assert_eq!(legacy.protocol(), NodeProtocolVersion::V3);
    assert_eq!(
        legacy.next_invocation().await.unwrap().params,
        json!({"verbose":true})
    );
    legacy.close().await;

    let current = connect().await.unwrap();
    assert_eq!(current.protocol(), NodeProtocolVersion::V4);
    current.close().await;
    server.await.unwrap();
}

async fn accept_node_connect(
    listener: &TcpListener,
    nonce: &str,
    timestamp: u64,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Value,
) {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(tcp).await.unwrap();
    send_json(
        &mut socket,
        json!({
            "type":"event", "event":"connect.challenge",
            "payload":{"nonce":nonce,"ts":timestamp}
        }),
    )
    .await;
    let connect = receive_json(&mut socket).await;
    (socket, connect)
}

fn assert_current_connect(connect: &Value, nonce: &str) {
    assert_eq!(connect["params"]["minProtocol"], 4);
    assert_eq!(connect["params"]["maxProtocol"], 4);
    assert_eq!(connect["params"]["client"]["platform"], "macos");
    assert_eq!(connect["params"]["client"]["deviceFamily"], "Mac");
    assert_eq!(connect["params"]["device"]["nonce"], nonce);
}

fn assert_legacy_connect(connect: &Value, nonce: &str) {
    assert_eq!(connect["params"]["minProtocol"], 3);
    assert_eq!(connect["params"]["maxProtocol"], 3);
    assert_eq!(connect["params"]["client"]["platform"], "darwin");
    assert!(connect["params"]["client"].get("deviceFamily").is_none());
    assert!(connect["params"]["client"].get("modelIdentifier").is_none());
    assert_eq!(connect["params"]["device"]["nonce"], nonce);
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn receive_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = socket.next().await.unwrap().unwrap();
    serde_json::from_str(message.into_text().unwrap().as_str()).unwrap()
}
