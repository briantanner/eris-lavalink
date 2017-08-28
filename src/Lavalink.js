'use strict';

const WebSocket = require('ws');

var EventEmitter;

try {
	EventEmitter = require('eventemitter3');
} catch (err) {
	EventEmitter = require('events').EventEmitter;
}

/**
 * @class Lavalink
 * @extends EventEmitter
 */
class Lavalink extends EventEmitter {
	constructor(options) {
		super();

		this.host = options.host;
		this.port = options.port || 80;
		this.address = `ws://${this.host}:${this.port}`;
		this.region = options.region || null;
		this.userId = options.userId;
		this.numShards = options.numShards;
		this.password = options.password || 'youshallnotpass';
		this.connected = false;
		this.draining = false;
		this.retries = 0;
		this.reconnectTimeout = options.timeout || 5000;
		this.reconnectInterval = null;
		this.stats = { players: 0, playingPlayers: 0 };
		this.disconnectHandler = this.disconnected.bind(this);

		this.connect();
	}

	/**
	 * Connect to the websocket server
	 */
	connect() {
		this.ws = new WebSocket(this.address, {
			headers: {
				'Authorization': this.password,
				'Num-Shards': this.numShards,
				'User-Id': this.userId,
			},
		});

		this.ws.on('open', this.ready.bind(this));
		this.ws.on('message', this.onMessage.bind(this));
		this.ws.on('close', this.disconnectHandler);
		this.ws.on('error', (err) => {
			this.emit('error', err);
		});
	}

	reconnect() {
		let interval = this.retryInterval();
		this.reconnectInterval = setTimeout(this.reconnect.bind(this), interval);
		this.retries++;
		this.connect();
	}

	destroy() {
		if (this.ws) {
			this.ws.removeListener('close', this.disconnectHandler);
			this.ws.close();
		}
	}

	/**
	 * Identify
	 */
	ready() {
		if (this.reconnectInterval) {
			clearTimeout(this.reconnectInterval);
			this.reconnectInterval = null;
		}

		this.connected = true;
		this.retries = 0;
		this.emit('ready');
	}

	/**
	 * Handle disconnect
	 */
	disconnected() {
		this.connected = false;
		if (!this.reconnectInterval) {
			this.emit('disconnect');
		}

		delete this.ws;

		if (!this.reconnectInterval) {
			this.reconnectInterval = setTimeout(this.reconnect.bind(this), this.reconnectTimeout);
		}
	}

	retryInterval() {
		let retries = Math.min(this.retries-1, 5);
		return Math.pow(retries + 5, 2) * 1000;
	}

	/**
	 * Send date to the server
	 * @param {String} op Op name
	 * @param {*} data Data to send
	 */
	send(data) {
		const ws = this.ws;
		if (!ws) return;

		try {
			var payload = JSON.stringify(data);
		} catch (err) {
			return this.emit('error', 'Unable to stringify payload.');
		}

		ws.send(payload);
	}

	/**
	 * Handle message from the server
	 * @param {String} message Raw websocket message
	 * @returns {*|void}
	 */
	onMessage(message) {
		try {
			var data = JSON.parse(message);
		} catch (e) {
			return this.emit('error', 'Unable to parse ws message.');
		}

		if (data.op && data.op === 'stats') {
			this.stats = data;
		}

		this.emit('message', data);
	}
}

module.exports = Lavalink;
