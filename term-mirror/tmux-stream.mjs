import * as os from 'node:os';
import * as pty from 'node-pty';

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

/// todo send pings
function start(cols, rows, res) {
  console.log(cols, rows);
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: process.env.HOME,
    env: process.env
  });

  res.on('error', (e) => {
    console.log('res error', e);
  })

  ptyProcess.onData((data) => {
    // process.stdout.write(data);
    try {
      res.write(data);
    } catch (e) {
      console.error(e)
    }
  });

  // ptyProcess.resize(100, 40);
  ptyProcess.write('tmux a\r');
}

import express from 'express'
var app = express()

app.get('*', (req, res) => {
  console.log(req.headers)

  start(req.headers.cols | 0, req.headers.rows | 0, res)

  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
})

app.listen(4000)
