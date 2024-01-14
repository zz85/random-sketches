const { readFileSync, writeFileSync } = require('fs')

// get certs otherwise create them
function getCerts() {
    const KEY_FILE = 'key.pem';
    const CERT_FILE = 'cert.pem';

    try {
        const key = readFileSync(KEY_FILE)
        const cert = readFileSync(CERT_FILE)

        return {
            key, cert
        }
    } catch (e) {
        // console.error(e)
    }

    const selfsigned = require('selfsigned');

    console.time('sign');
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const pems = selfsigned.generate(attrs, { days: 3650 });

    const key = pems.private;
    const cert = pems.cert;


    writeFileSync(KEY_FILE, key);
    writeFileSync(CERT_FILE, cert);

    console.timeEnd('sign');
    console.log(pems)

    return {
        key, cert
    }
}

class Streamer {
    constructor() {
        this.clients = new Set();

        setInterval(() => {
            this.broadcast({ time: Date.now() }, 'ping');
        }, 5000);
    }

    add(req, res) {
        var client = new Client(req, res);
        res.on('close', () => {
            this.clients.delete(client);
            console.log(`closing client. Total: ${this.clients.size}`)
        });

        this.clients.add(client);

        console.log(`new streaming client. Total: ${this.clients.size}`)

        this.broadcast({ time: Date.now() }, 'ping');
        this.broadcast({
            clients: this.clients.size,
        })

        // res.write(`data: ${JSON.stringify({'hello': 'world'})}\n\n`);
        // res.write(`data: ${JSON.stringify([1,2,3])}\n\n`);
        // res.write(`data: ${JSON.stringify('yolo')}\n\n`);
        // res.write(`data: 12345\n\n`);
    }

    broadcast(content, event) {
        const json = JSON.stringify(content);
        for (let client of this.clients) {
            if (event) {
                client.event(event, json);
            } else {
                client.send(json);
            }
        }
    }
}

// streaming client
class Client {
    constructor(req, res) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.httpVersion !== '2.0') {
            res.setHeader('Connection', 'keep-alive');
        }
        res.flushHeaders();

        res.on('close', () => {
            res.end();
        });

        this.res = res;
    }

    send(content) {
        this.res.write(`data: ${content}\n\n`);
    }

    event(name, content) {
        this.res.write(`event: ${name}\ndata: ${content}\n\n`);
    }
}

const certs = getCerts();
const streamer = new Streamer();

const express = require('express');
const http2Express = require('http2-express-bridge');
const http2 = require('http2');
// const bodyParser = require('body-parser')

const app = http2Express(express);

app.use(express.static('public'))
app.use(express.json());

app.post('/collect', (req, res) => {
    console.log('POST', req.body);

    streamer.broadcast({ time: req.body.time }, 'collect')
    res.end();
})

app.get('/streaming', (req, res) => {
    streamer.add(req, res);
});

const options = {
    key: certs.key,
    cert: certs.cert,
    allowHTTP1: !true
}

const PORT = 3000;

console.log(`running on port ${PORT}`);
const server = http2.createSecureServer(options, app)
server.listen(PORT)
