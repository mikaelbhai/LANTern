//! UPnP Internet Gateway Device control.
//!
//! This is what lets LANTern open a hole in the router it sits behind, so
//! devices on the network *above* can start conversations with this one — the
//! direction a NAT otherwise blocks outright.
//!
//! The protocol is SSDP discovery over multicast followed by SOAP over HTTP.
//! Both are simple enough to speak directly, which avoids pulling an HTTP
//! client and an XML parser into the build for a few hundred bytes of traffic.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

const SSDP_ADDR: &str = "239.255.255.250:1900";

/// The two service types an IGD may expose for port mapping, in preference
/// order — IP first, PPP for DSL-style gateways.
const SERVICE_TYPES: [&str; 2] = [
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

#[derive(Debug, Clone)]
pub struct Gateway {
    /// Absolute URL of the control endpoint.
    pub control_url: String,
    /// Service type the control endpoint speaks.
    pub service_type: String,
}

#[derive(Debug, Clone, Copy)]
struct Url<'a> {
    host: &'a str,
    port: u16,
    path: &'a str,
}

fn parse_url(url: &str) -> Option<Url<'_>> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (authority, 80),
    };
    Some(Url { host, port, path })
}

/// Case-insensitive header lookup on a raw HTTP response or SSDP reply.
fn header<'a>(raw: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{}:", name.to_ascii_lowercase());
    raw.lines()
        .find(|l| l.to_ascii_lowercase().starts_with(&needle))
        .map(|l| l[needle.len()..].trim())
}

/// Pulls the text between `<tag>` and `</tag>`.
fn tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// Collects every port-mapping endpoint on the network.
///
/// A dual-WAN router exposes one connection service per WAN link, and some
/// sites run more than one gateway outright. Stopping at the first answer
/// leaves the other links unmapped, so inbound traffic arriving over them is
/// still dropped — which looks like the feature simply not working. Every
/// distinct control URL is kept.
pub async fn discover_all(timeout: Duration) -> Vec<Gateway> {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await else {
        return Vec::new();
    };
    let _ = socket.set_broadcast(true);

    let probe = format!(
        "M-SEARCH * HTTP/1.1\r\n\
         HOST: {SSDP_ADDR}\r\n\
         MAN: \"ssdp:discover\"\r\n\
         MX: 2\r\n\
         ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n"
    );
    if socket.send_to(probe.as_bytes(), SSDP_ADDR).await.is_err() {
        return Vec::new();
    }

    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = [0u8; 2048];
    let mut seen: Vec<String> = Vec::new();
    let mut gateways: Vec<Gateway> = Vec::new();

    // Listen for the whole window rather than returning early: responders
    // stagger their replies to avoid colliding, so the second WAN often answers
    // noticeably later than the first.
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Ok(Ok((len, _))) =
            tokio::time::timeout(remaining, socket.recv_from(&mut buf)).await
        else {
            break;
        };

        let reply = String::from_utf8_lossy(&buf[..len]);
        let Some(location) = header(&reply, "location") else {
            continue;
        };
        if seen.iter().any(|l| l == location) {
            continue;
        }
        seen.push(location.to_string());

        for gateway in describe(location).await {
            if !gateways.iter().any(|g| g.control_url == gateway.control_url) {
                gateways.push(gateway);
            }
        }
    }

    gateways
}

/// Fetches a device description and locates every port-mapping service in it.
async fn describe(location: &str) -> Vec<Gateway> {
    let Ok(xml) = http_get(location).await else {
        return Vec::new();
    };
    let mut out: Vec<Gateway> = Vec::new();

    for service_type in SERVICE_TYPES {
        // A dual-WAN device declares the same service type once per link, so
        // every occurrence matters — not just the first.
        let mut cursor = 0usize;
        while let Some(offset) = xml[cursor..].find(service_type) {
            let idx = cursor + offset;
            cursor = idx + service_type.len();

            let Some(control) = tag_text(&xml[idx..], "controlURL") else {
                continue;
            };
            let gateway = Gateway {
                control_url: absolute(location, control),
                service_type: service_type.to_string(),
            };
            if !out.iter().any(|g| g.control_url == gateway.control_url) {
                out.push(gateway);
            }
        }
    }
    out
}

/// Control URLs are usually relative to the description's origin.
fn absolute(base: &str, path: &str) -> String {
    if path.starts_with("http://") {
        return path.to_string();
    }
    let Some(url) = parse_url(base) else {
        return path.to_string();
    };
    let sep = if path.starts_with('/') { "" } else { "/" };
    format!("http://{}:{}{}{}", url.host, url.port, sep, path)
}

async fn http_get(url: &str) -> std::io::Result<String> {
    let parsed = parse_url(url)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad url"))?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHOST: {}:{}\r\nCONNECTION: close\r\n\r\n",
        parsed.path, parsed.host, parsed.port
    );
    let body = exchange(parsed.host, parsed.port, request.into_bytes()).await?;
    Ok(body)
}

/// Sends a SOAP action and returns the response body.
async fn soap(gateway: &Gateway, action: &str, arguments: &str) -> std::io::Result<String> {
    let parsed = parse_url(&gateway.control_url)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad control url"))?;

    let body = format!(
        "<?xml version=\"1.0\"?>\
         <s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
         <s:Body><u:{action} xmlns:u=\"{st}\">{arguments}</u:{action}></s:Body>\
         </s:Envelope>",
        action = action,
        st = gateway.service_type,
        arguments = arguments
    );

    let request = format!(
        "POST {} HTTP/1.1\r\n\
         HOST: {}:{}\r\n\
         CONTENT-TYPE: text/xml; charset=\"utf-8\"\r\n\
         SOAPACTION: \"{}#{}\"\r\n\
         CONTENT-LENGTH: {}\r\n\
         CONNECTION: close\r\n\r\n{}",
        parsed.path,
        parsed.host,
        parsed.port,
        gateway.service_type,
        action,
        body.len(),
        body
    );

    exchange(parsed.host, parsed.port, request.into_bytes()).await
}

/// One request/response over a short-lived connection.
async fn exchange(host: &str, port: u16, request: Vec<u8>) -> std::io::Result<String> {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(4),
        TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timed out"))??;

    stream.write_all(&request).await?;
    stream.flush().await?;

    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(6), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "read timed out"))??;

    let text = String::from_utf8_lossy(&raw).into_owned();
    // Strip the status line and headers; callers only care about the body.
    Ok(match text.find("\r\n\r\n") {
        Some(i) => text[i + 4..].to_string(),
        None => text,
    })
}

/// The router's address on the network above it.
pub async fn external_ip(gateway: &Gateway) -> Option<String> {
    let body = soap(gateway, "GetExternalIPAddress", "").await.ok()?;
    tag_text(&body, "NewExternalIPAddress")
        .map(str::to_string)
        .filter(|ip| !ip.is_empty() && ip != "0.0.0.0")
}

/// Asks the router to forward `external_port` to this device.
///
/// A zero lease means "until removed"; some gateways reject that and want a
/// bounded lease, so a failure retries with one before giving up.
pub async fn add_port_mapping(
    gateway: &Gateway,
    external_port: u16,
    internal_port: u16,
    internal_ip: &str,
    proto: &str,
    description: &str,
) -> Result<(), String> {
    for lease in [0u32, 3600] {
        let arguments = format!(
            "<NewRemoteHost></NewRemoteHost>\
             <NewExternalPort>{external_port}</NewExternalPort>\
             <NewProtocol>{proto}</NewProtocol>\
             <NewInternalPort>{internal_port}</NewInternalPort>\
             <NewInternalClient>{internal_ip}</NewInternalClient>\
             <NewEnabled>1</NewEnabled>\
             <NewPortMappingDescription>{description}</NewPortMappingDescription>\
             <NewLeaseDuration>{lease}</NewLeaseDuration>"
        );
        match soap(gateway, "AddPortMapping", &arguments).await {
            Ok(body) if !body.contains("UPnPError") => return Ok(()),
            Ok(body) => {
                if lease != 0 {
                    return Err(fault(&body));
                }
            }
            Err(e) => {
                if lease != 0 {
                    return Err(e.to_string());
                }
            }
        }
    }
    Err("gateway refused the mapping".into())
}

pub async fn delete_port_mapping(
    gateway: &Gateway,
    external_port: u16,
    proto: &str,
) -> Result<(), String> {
    let arguments = format!(
        "<NewRemoteHost></NewRemoteHost>\
         <NewExternalPort>{external_port}</NewExternalPort>\
         <NewProtocol>{proto}</NewProtocol>"
    );
    match soap(gateway, "DeletePortMapping", &arguments).await {
        Ok(body) if !body.contains("UPnPError") => Ok(()),
        Ok(body) => Err(fault(&body)),
        Err(e) => Err(e.to_string()),
    }
}

/// Probes the real router on this network.
///
/// Ignored by default because it depends on the surrounding network; run it
/// explicitly with `cargo test -- --ignored --nocapture` to see what the
/// gateway here actually supports.
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn probe_local_gateway() {
        let gateways = discover_all(Duration::from_secs(4)).await;
        if gateways.is_empty() {
            println!("no UPnP gateway answered — router has it off or absent");
            return;
        }
        println!("{} uplink(s) found", gateways.len());
        for (i, gateway) in gateways.iter().enumerate() {
            println!("  [{i}] service : {}", gateway.service_type);
            println!("      control : {}", gateway.control_url);
            match external_ip(gateway).await {
                Some(ip) => println!("      wan ip  : {ip}"),
                None => println!("      wan ip  : unavailable"),
            }
        }
    }
}

/// Turns a SOAP fault into something worth showing a person.
fn fault(body: &str) -> String {
    let code = tag_text(body, "errorCode").unwrap_or("unknown");
    let description = tag_text(body, "errorDescription").unwrap_or("gateway refused the request");
    match code {
        "718" => "That port is already mapped to another device".into(),
        "725" => "The router only supports permanent leases".into(),
        "402" => "The router rejected the request as malformed".into(),
        _ => format!("{description} (UPnP error {code})"),
    }
}
