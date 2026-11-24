"""WebSocket JSON messages over Codex's private local Unix control socket.

The CLI proxy forwards raw socket bytes, including the HTTP upgrade and frames;
it is not the newline JSON transport provided by `app-server --listen stdio://`.
Closing this adapter only closes our client connection, never the daemon.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import threading


class DaemonConnection:
    MAX_MESSAGE = 32 * 1024 * 1024

    def __init__(self, path=None):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.closed = threading.Event()
        self.write_lock = threading.Lock()
        self.buffer = bytearray()
        self.stdin = self.stdout = self
        self.socket.settimeout(10)
        self.socket.connect(str(path or Path.home()/'.codex/app-server-control/app-server-control.sock'))
        if hasattr(socket, 'SO_PEERCRED'):
            _, uid, _ = struct.unpack('3i', self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != os.getuid():
                self.socket.close()
                raise PermissionError('The Codex daemon belongs to a different user.')
        key = base64.b64encode(os.urandom(16)).decode()
        self.socket.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                             f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        while b'\r\n\r\n' not in self.buffer:
            chunk = self.socket.recv(4096)
            if not chunk or len(self.buffer)>16384:
                raise ConnectionError('Codex did not accept the local connection.')
            self.buffer.extend(chunk)
        header, remaining = bytes(self.buffer).split(b'\r\n\r\n', 1)
        self.buffer = bytearray(remaining)
        lines = header.decode('ascii').split('\r\n')
        fields = {line.split(':',1)[0].lower():line.split(':',1)[1].strip() for line in lines[1:] if ':' in line}
        accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not lines[0].startswith('HTTP/1.1 101 ') or fields.get('sec-websocket-accept','')!=accept:
            self.socket.close()
            raise ConnectionError('Invalid Codex WebSocket handshake.')
        self.socket.settimeout(None)

    def _exact(self, size):
        while len(self.buffer)<size:
            data = self.socket.recv(min(65536, size-len(self.buffer)))
            if not data: raise EOFError('Codex daemon disconnected.')
            self.buffer.extend(data)
        result = bytes(self.buffer[:size]);del self.buffer[:size]
        return result

    def _send(self, opcode, payload):
        size = len(payload)
        length = bytes([size|128]) if size<126 else b'\xfe'+struct.pack('>H',size) if size<65536 else b'\xff'+struct.pack('>Q',size)
        mask = os.urandom(4)
        frame = bytes([128|opcode])+length+mask+bytes(b^mask[i%4] for i,b in enumerate(payload))
        with self.write_lock:self.socket.sendall(frame)

    def write(self, value):
        self._send(1, value.rstrip('\n').encode('utf-8'))

    def flush(self): pass

    def __iter__(self):
        fragments = bytearray()
        try:
            while not self.closed.is_set():
                head = self._exact(2)
                opcode, final, masked, length = head[0]&15, bool(head[0]&128), bool(head[1]&128), head[1]&127
                if head[0]&112: raise ValueError('Unsupported compressed WebSocket frame.')
                if length==126:length=struct.unpack('>H',self._exact(2))[0]
                elif length==127:length=struct.unpack('>Q',self._exact(8))[0]
                if length>self.MAX_MESSAGE:raise ValueError('Codex response is too large.')
                mask=self._exact(4) if masked else None
                payload=self._exact(length)
                if mask:payload=bytes(b^mask[i%4] for i,b in enumerate(payload))
                if opcode==8:return
                if opcode==9:self._send(10,payload);continue
                if opcode==10:continue
                if opcode not in (0,1):raise ValueError('Unsupported Codex message frame.')
                if opcode==1:fragments.clear()
                fragments.extend(payload)
                if len(fragments)>self.MAX_MESSAGE:raise ValueError('Codex response is too large.')
                if final:
                    yield fragments.decode('utf-8');fragments.clear()
        finally:self.closed.set()

    def wait(self, timeout=None):
        if not self.closed.wait(timeout):raise TimeoutError('Connection is still open.')
        return 0

    def terminate(self):
        self.closed.set()
        try:self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:pass
        self.socket.close()
