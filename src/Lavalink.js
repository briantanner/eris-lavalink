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
		this.region = options.region;
		this.userId = options.userId;
		this.numShards = options.numShards;
		this.reconnectTimeout = options.timeout || 30000;
		this.reconnectInterval = null;
		this.stats = { players: 0, playingPlayers: 0 };

		this.connect();
	}

	/**
	 * Connect to the websocket server
	 */
	connect() {
		let url = `ws://${this.host}`;
		this.ws = new WebSocket(url, {
			headers: {
				'Authorization': 'youshallnotpass',
				'Num-Shards': this.numShards,
				'User-Id': this.userId,
			},
		});

		this.ws.on('open', this.ready.bind(this));
		this.ws.on('message', this.onMessage.bind(this));
		this.ws.on('close', this.disconnected.bind(this));
		this.ws.on('error', this.disconnected.bind(this));
	}

	/**
	 * Identify
	 */
	ready() {
		if (this.reconnectInterval) {
			clearInterval(this.reconnectInterval);
			process.nextTick(() => {
				this.reconnectInterval = null;
			});
		}

		this.emit('ready');
	}

	/**
	 * Handle disconnect
	 */
	disconnected() {
		if (!this.reconnectInterval) {
			this.emit('disconnect');
		}

		delete this.ws;

		if (!this.reconnectInterval) {
			this.reconnectInterval = setInterval(this.connect.bind(this), this.reconnectTimeout);
		}
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

		console.log(payload);

		ws.send(payload);
	}

	/**
	 * Handle message from the server
	 * @param {String} message Raw websocket message
	 * @returns {*|void}
	 */
	onMessage(message) {
		// console.log(message);
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
