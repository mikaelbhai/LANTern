//! Minimal STUN server (RFC 5389) for ICE candidate gathering.
//!
//! Peers need a reflexive address to negotiate WebRTC, and asking a public
//! STUN server would mean reaching the internet. Binding requests are the only
//! method ICE actually needs, so that is all this answers.

use tokio::net::UdpSocket;

const MAGIC_COOKIE: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

pub async fn serve(port: u16) -> std::io::Result<()> {
    let socket = UdpSocket::bind(("0.0.0.0", port)).await?;
    let mut buf = [0u8; 1024];

    loop {
        let Ok((len, from)) = socket.recv_from(&mut buf).await else {
            continue;
        };
        let Some(reply) = handle(&buf[..len], from) else {
            continue;
        };
        let _ = socket.send_to(&reply, from).await;
    }
}

fn handle(packet: &[u8], from: std::net::SocketAddr) -> Option<Vec<u8>> {
    // Header: type(2) length(2) cookie(4) transaction id(12)
    if packet.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([packet[0], packet[1]]);
    let cookie = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    if msg_type != BINDING_REQUEST || cookie != MAGIC_COOKIE {
        return None;
    }
    let txid = &packet[8..20];

    let std::net::SocketAddr::V4(v4) = from else {
        // IPv6 reflexive addresses are not needed on a LAN deployment.
        return None;
    };

    // XOR-MAPPED-ADDRESS: reserved(1) family(1) xport(2) xaddr(4)
    let xport = v4.port() ^ ((MAGIC_COOKIE >> 16) as u16);
    let xaddr = u32::from(*v4.ip()) ^ MAGIC_COOKIE;

    let mut attr = Vec::with_capacity(12);
    attr.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
    attr.extend_from_slice(&8u16.to_be_bytes()); // value length
    attr.push(0); // reserved
    attr.push(0x01); // family: IPv4
    attr.extend_from_slice(&xport.to_be_bytes());
    attr.extend_from_slice(&xaddr.to_be_bytes());

    let mut out = Vec::with_capacity(20 + attr.len());
    out.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    out.extend_from_slice(&(attr.len() as u16).to_be_bytes());
    out.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    out.extend_from_slice(txid);
    out.extend_from_slice(&attr);
    Some(out)
}
