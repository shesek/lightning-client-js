'use strict';

const path = require('path');
const net = require('net');
const debug = require('debug')('lightning-client');
const {EventEmitter} = require('events');
const JSONParser = require('jsonparse')
const LightningError = require('error/typed')({ type: 'lightning', message: 'lightning-client error' })
const methods = require('./methods');

const defaultRpcPath = path.join(require('os').homedir(), '.lightning')

class LightningClient extends EventEmitter {
    constructor(rpcPath=defaultRpcPath, rpcPort) {
        if (rpcPort) {
            rpcPort = Number(rpcPort);

            if (!rpcPort || rpcPort < 0 || rpcPort > 65535) {
                rpcPort = null;
            }
        }

        if (rpcPort) {
            debug(`Connecting to ${rpcPath}:${rpcPort} (TCP)`);
        } else {
            if (!path.isAbsolute(rpcPath)) {
                throw new Error('The rpcPath must be an absolute path');
            }

            if (rpcPath.slice(-14) !== '/lightning-rpc') {
                rpcPath = path.join(rpcPath, '/lightning-rpc');
            }

            debug(`Connecting to ${rpcPath}`);
        }

        super();
        this.rpcPath = rpcPath;
        this.rpcPort = rpcPort;
        this.reconnectWait = 0.5;
        this.reconnectTimeout = null;
        this.reqcount = 0;
        this.parser = new JSONParser

        const _self = this;

        if (rpcPort) {
            this.client = net.createConnection(rpcPort, rpcPath);
        } else {
            this.client = net.createConnection(rpcPath);
        }

        this.clientConnectionPromise = new Promise(resolve => {
            _self.client.on('connect', () => {
                debug(`Lightning client connected`);
                _self.reconnectWait = 1;
                resolve();
            });

            _self.client.on('end', () => {
                console.error('Lightning client connection closed, reconnecting');
                _self.increaseWaitTime();
                _self.reconnect();
            });

            _self.client.on('error', error => {
                console.error(`Lightning client connection error`, error);
                _self.emit('error', error);
                _self.increaseWaitTime();
                _self.reconnect();
            });
        });

        this.client.on('data', data => _self.parser.write(data));

        this.parser.onValue = function(val) {
          if (this.stack.length) return; // top-level objects only
          debug('#%d <-- %O', val.id, val.error || val.result)
          _self.emit('res:' + val.id, val);
        }

    }

    increaseWaitTime() {
        if (this.reconnectWait >= 16) {
            this.reconnectWait = 16;
        } else {
            this.reconnectWait *= 2;
        }
    }

    reconnect() {
        const _self = this;

        if (this.reconnectTimeout) {
            return;
        }

        this.reconnectTimeout = setTimeout(() => {
            debug('Trying to reconnect...');

            if (_self.rpcPort) {
                _self.client.connect(_self.rpcPort, _self.rpcPath);
            } else {
                _self.client.connect(_self.rpcPath);
            }

            _self.reconnectTimeout = null;
        }, this.reconnectWait * 1000);
    }

    call(method, args = []) {
        const _self = this;

        const callInt = ++this.reqcount;
        const sendObj = {
            method,
            params: args,
            id: ''+callInt
        };

        debug('#%d --> %s %o', callInt, method, args)

        // Wait for the client to connect
        return this.clientConnectionPromise
            .then(() => new Promise((resolve, reject) => {
                // Wait for a response
                this.once('res:' + callInt, res => res.error == null
                  ? resolve(res.result)
                  : reject(LightningError(res.error))
                );

                // Send the command
                _self.client.write(JSON.stringify(sendObj));
            }));
    }
}

const protify = s => s.replace(/-([a-z])/g, m => m[1].toUpperCase());

methods.forEach(k => {
    LightningClient.prototype[protify(k)] = function (...args) {
        return this.call(k, args);
    };
});

module.exports = (rpcPath, rpcPort) => new LightningClient(rpcPath, rpcPort);
module.exports.LightningClient = LightningClient;
module.exports.LightningError = LightningError;
