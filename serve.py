import http.server
import os
os.chdir('/Users/xin/Desktop/Claude Code/NERD/docs')
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=8080, bind='127.0.0.1')
