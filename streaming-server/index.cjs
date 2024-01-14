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

const certs = getCerts();

const express = require('express');
const http2Express = require('http2-express-bridge');
const http2 = require('http2');
const app = http2Express(express);

app.use(express.static('public'))

const options = {
    key: certs.key,
    cert: certs.cert,
    allowHTTP1: !true
}

const PORT = 3000;

console.log(`running on port ${PORT}`);
const server = http2.createSecureServer(options, app)
server.listen(PORT)
