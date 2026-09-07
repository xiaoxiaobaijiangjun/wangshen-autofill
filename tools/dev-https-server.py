# 验收用本地 HTTPS 静态服务器。
# 背景：Edge 会把 http://app.mokahr.com 这类真实域名强制升级为 HTTPS（HSTS/HTTPS-First），
# 纯 HTTP 的本地 mock 页面因此加载失败（chrome-error）。改用自签证书 HTTPS 后，
# 配合 Edge 的 --ignore-certificate-errors 即可稳定加载域名映射页。
# 用法：python tools/dev-https-server.py [端口，默认 8321]  （工作目录自动切到项目根）
import functools
import http.server
import os
import ssl
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8321

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(
    os.path.join(ROOT, 'tools', 'test-cert.pem'),
    os.path.join(ROOT, 'tools', 'test-key.pem'),
)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
print('https listening on 0.0.0.0:%d, serving %s' % (PORT, ROOT), flush=True)
httpd.serve_forever()
