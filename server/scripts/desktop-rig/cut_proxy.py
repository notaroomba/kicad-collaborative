#!/usr/bin/env python3
"""A TCP proxy in front of the collaboration server whose cable can be pulled.

    python3 cut_proxy.py [listen=8097] [target=8099] [control=8096]

Point one editor at the listen port (RIG_SERVER=http://127.0.0.1:8097 ./launch.sh a ...)
and leave the other on the server itself.  Then, on the control port:

    curl 127.0.0.1:8096/down    connections are closed and new ones refused (no network)
    curl 127.0.0.1:8096/stall   connections stay open but carry nothing (a dead link:
                                the editor has to notice by itself that the server went quiet)
    curl 127.0.0.1:8096/up      back to normal
    curl 127.0.0.1:8096/state
"""
import asyncio, sys

LISTEN = int(sys.argv[1]) if len(sys.argv) > 1 else 8097
TARGET = int(sys.argv[2]) if len(sys.argv) > 2 else 8099
CONTROL = int(sys.argv[3]) if len(sys.argv) > 3 else 8096

state = 'up'
flowing = asyncio.Event()
writers = set()
server = None


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            await flowing.wait()        # stalled: hold the bytes, keep the socket
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(reader, writer):
    writers.add(writer)
    try:
        await flowing.wait()
        up_reader, up_writer = await asyncio.open_connection('127.0.0.1', TARGET)
    except Exception:
        writer.close()
        writers.discard(writer)
        return
    writers.add(up_writer)
    await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    writers.discard(writer)
    writers.discard(up_writer)


async def listen():
    global server
    if server is None:
        server = await asyncio.start_server(handle, '127.0.0.1', LISTEN)


async def unlisten():
    global server
    # Connections first: since Python 3.12 wait_closed() waits for every one of them.
    for w in list(writers):
        try:
            w.transport.abort()
        except Exception:
            pass
    writers.clear()
    if server is not None:
        server.close()
        server = None


async def control(reader, writer):
    global state
    line = (await reader.readline()).decode(errors='replace')
    want = line.split(' ')[1].strip('/') if ' ' in line else ''
    if want == 'down':
        state = 'down'
        flowing.set()           # release anything parked so it can be torn down
        await unlisten()
    elif want == 'stall':
        state = 'stall'
        flowing.clear()
        await listen()
    elif want == 'up':
        if state == 'stall':
            # what was held back belongs to a link the editor gave up on
            await unlisten()
        state = 'up'
        flowing.set()
        await listen()
    body = state + '\n'
    writer.write(f'HTTP/1.1 200 OK\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n{body}'.encode())
    await writer.drain()
    writer.close()


async def main():
    flowing.set()
    await listen()
    ctl = await asyncio.start_server(control, '127.0.0.1', CONTROL)
    print(f'proxy {LISTEN} -> {TARGET}, control {CONTROL}', flush=True)
    async with ctl:
        await ctl.serve_forever()


asyncio.run(main())
