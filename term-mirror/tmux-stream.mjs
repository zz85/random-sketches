import * as os from 'node:os';
import * as pty from 'node-pty';

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

var ids = new Map();

function resize(cols, rows, id) {
  var process = ids.get(id);
  if (process) {
    console.log('resizing', cols, rows)
    process.resize(cols, rows);
  }
}

/// todo send pings
function start(cols, rows, res, id) {
  // multiplexing currently done by tmux rather than nodejs
  console.log(cols, rows);
  let ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 30,
    cwd: process.env.HOME,
    env: process.env
  });

  ids.set(id, ptyProcess);

  res.on('error', (e) => {
    console.log('res error', e);
  })

  res.on('close', (e) => {
    console.log('res close')
    ptyProcess.kill();
    ptyProcess = null;
    ids.delete(id)
  });

  ptyProcess.onData((data) => {
    // process.stdout.write(data);
    try {
      res.write(data);
    } catch (e) {
      console.error(e)
    }
  });

  ptyProcess.write('tmux a\r');
}

import express from 'express'
var app = express()
app.use(express.json());

app.get('*', (req, res) => {
  console.log('get', req.url, req.headers)

  start(req.headers.cols | 0, req.headers.rows | 0, res, req.headers.id)

  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.flushHeaders();
})

app.post('/tmux/resize', (req, res) => {
  resize(req.headers.cols | 0, req.headers.rows | 0, req.headers.id);
  res.sendStatus(200);
})


app.post('/tmux/send', (req, res) => {
  console.log('data', req.headers.id, req.body)
  const { data } = req.body;
  const term = ids.get(req.headers.id);
  if (term) {
    term.write(data);
  }

  res.sendStatus(200);
})

app.listen(4000)
