// 验收用本地转发代理：把 Edge 的所有请求原样转发到本地 HTTPS mock 服务器(127.0.0.1:8321)。
// 背景：Edge 152.0.4191.66 起 --host-resolver-rules 对映射域名失效（请求打到真实站点），
// 改用 --proxy-server 让域名解析发生在代理侧，绕开浏览器解析器。
// 用法：node tools/dev-proxy.js [代理端口，默认 8399] [上游端口，默认 8321]
'use strict';
const http = require('http');
const net = require('net');

const PROXY_PORT = Number(process.argv[2]) || 8399;
const UPSTREAM_PORT = Number(process.argv[3]) || 8321;

// 普通请求（http 绝对地址形式）
const server = http.createServer((req, res) => {
  let path = req.url;
  try {
    const u = new URL(req.url, 'http://placeholder');
    path = u.pathname + u.search;
  } catch (e) { /* 原样透传 */ }
  const fwd = http.request(
    { host: '127.0.0.1', port: UPSTREAM_PORT, path, method: req.method, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    }
  );
  fwd.on('error', () => {
    try { res.writeHead(502); res.end('proxy upstream error'); } catch (e) { /* 已响应 */ }
  });
  req.pipe(fwd);
});

// CONNECT 隧道（https 请求）
server.on('connect', (req, clientSock, head) => {
  const upstream = net.connect(UPSTREAM_PORT, '127.0.0.1', () => {
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSock);
    clientSock.pipe(upstream);
  });
  upstream.on('error', () => clientSock.destroy());
  clientSock.on('error', () => upstream.destroy());
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  console.log(`proxy 127.0.0.1:${PROXY_PORT} -> 127.0.0.1:${UPSTREAM_PORT}`);
});
