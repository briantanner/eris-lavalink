/**
 * Created by Julian & NoobLance on 25.05.2017.
 * DISCLAIMER: We reuse some eris code
 */
const { Collection, Constants } = require('eris');
const Lavalink = require('./Lavalink');
const Player = require('./Player');

/**
 * Drop in Replacement for the eris voice connection manager
 * @class PlayerManager
 * @extends Collection
 */
class PlayerManager extends Collection {
    /**
     * PlayerManager constructor
     * @param {Client} client Eris client
     * @param {Object[]} nodes The Lavalink nodes to connect to
     * @param {Object} [options] Setup options
     * @param {string} [options.defaultRegion] The default region
     * @param {number} [options.failoverRate=250] Failover rate in ms
     * @param {number} [options.failoverLimit=1] Number of connections to failover per rate limit
     * @param {Object} [options.player] Optional Player class to replace the default Player
     * @param {number} [options.reconnectThreshold=2000] The amount of time to skip ahead in a song when reconnecting in ms
     * @param {Object} [options.regions] Region mapping object
     */
    constructor(client, nodes, options) {
        super(options.player || Player);

        this.client = client;
        this.nodes = new Collection();
        this.pendingGuilds = {};
        this.options = options || {};
        this.failoverQueue = [];
        this.failoverRate = options.failoverRate || 250;
        this.failoverLimit = options.failoverLimit || 1;

        this.defaultRegions = {
            asia: ['hongkong', 'singapore', 'sydney'],
            eu: ['eu', 'amsterdam', 'frankfurt', 'russia'],
            us: ['us', 'brazil'],
        };

        this.regions = options.regions || this.defaultRegions;

        for (let node of nodes) {
            this.createNode(Object.assign({}, node, options));
        }

        this.shardReadyListener = this.shardReady.bind(this);
        this.client.on('shardReady', this.shardReadyListener);
    }

    /**
     * Create a Lavalink node
     * @param {Object} options Lavalink node options
     * @param {string} options.host The hostname to connect to
     * @param {string} options.port The port to connect with
     * @param {string} options.region The region of the node
     * @param {number} options.numShards The number of shards the bot is running
     * @param {string} options.userId The user id of the bot
     * @param {string} options.password The password for the Lavalink node
     */
    createNode(options) {
        let node = new Lavalink({
            host: options.host,
            port: options.port,
            region: options.region,
            numShards: options.numShards,
            userId: options.userId,
            password: options.password,
        });

        node.on('error', this.onError.bind(this, node));
        node.on('disconnect', this.onDisconnect.bind(this, node));
        node.on('message', this.onMessage.bind(this, node));

        this.nodes.set(options.host, node);
    }

    /**
     * Remove a Lavalink node
     * @param {string} host The hostname of the node
     */
    removeNode(host) {
        let node = this.nodes.get(host);
        if (!host) return;
        node.destroy();
        this.nodes.delete(host);
        this.onDisconnect(node);
    }

    /**
     * Check the failover queue
     * @private
     */
    checkFailoverQueue() {
        if (this.failoverQueue.length > 0) {
            let fns = this.failoverQueue.splice(0, this.failoverLimit);
            for (let fn of fns) {
                this.processQueue(fn);
            }
        }
    }

    /**
     * Queue a failover
     * @param {Function} fn The failover function to queue
     * @private
     */
    queueFailover(fn) {
        if (this.failoverQueue.length > 0) {
            this.failoverQueue.push(fn);
        } else {
            return this.processQueue(fn);
        }
    }

    /**
     * Process the failover queue
     * @param {Function} fn The failover function to call
     * @private
     */
    processQueue(fn) {
        fn();
        setTimeout(() => this.checkFailoverQueue(), this.failoverRate);
    }

    /**
     * Called when an error is received from a Lavalink node
     * @param {Lavalink} node The Lavalink node
     * @param {string|Error} err The error received
     * @private
     */
    onError(node, err) {
        this.client.emit(err);
    }

    /**
     * Called when a node disconnects
     * @param {Lavalink} node The Lavalink node
     * @param {*} msg The disconnect message if sent
     * @private
     */
    onDisconnect(node, msg) {
        let players = this.filter(player => player.node.host === node.host);
        for (let player of players) {
            this.queueFailover(this.switchNode.bind(this, player, true));
        }
    }

    /**
     * Called when a shard readies
     * @param {number} id Shard ID
     * @private
     */
    shardReady(id) {
        let players = this.filter(player => player.shard && player.shard.id === id);
        for (let player of players) {
            this.queueFailover(this.switchNode.bind(this, player));
        }
    }

    /**
     * Switch the voice node of a player
     * @param {Player} player The Player instance
     * @param {boolean} leave Whether to leave the channel or not on our side
     */
    switchNode(player, leave) {
        let { guildId, channelId, track, paused } = player,
            position = (player.state.position || 0) + (this.options.reconnectThreshold || 2000);

        let listeners = player.listeners('end'),
            endListeners = [];

        if (listeners && listeners.length) {
            for (let listener of listeners) {
                endListeners.push(listener);
                player.removeListener('end', listener);
            }
        }

        player.once('end', () => {
            for (let listener of endListeners) {
                player.on('end', listener);
            }
        });

        this.delete(guildId);

        player.playing = false;

        if (leave) {
            player.updateVoiceState(null);
        } else {
            player.node.send({ op: 'disconnect', guildId: guildId });
        }

        process.nextTick(() => {
            this.join(guildId, channelId, null, player).then(player => {
                if (paused) {
                    player.pause();
                }
                player.play(track, { startTime: position });
                player.emit('reconnect');
                this.set(guildId, player);
            })
            .catch(err => {
                player.emit('disconnect', err);
                player.disconnect();
            });
        });
    }

    /**
     * Called when a message is received from the voice node
     * @param {Lavalink} node The Lavalink node
     * @param {*} message The message received
     * @private
     */
    onMessage(node, message) {
        if (!message.op) return;

        switch (message.op) {
            case 'validationReq': {
                let payload = {
                    op: 'validationRes',
                    guildId: message.guildId,
                    valid: false,
                };

                if (message.channelId && message.channelId.length) {
                    let voiceChannel = this.client.getChannel(message.channelId);
                    if (voiceChannel) {
                        payload.channelId = voiceChannel.id;
                        payload.valid = true;
                    }
                } else {
                    payload.valid = true;
                }

                return node.send(payload);
            }
            case 'isConnectedReq': {
                let payload = {
                    op: 'isConnectedRes',
                    shardId: parseInt(message.shardId),
                    connected: false,
                };

                let shard = this.client.shards.get(message.shardId);
                if (shard && shard.status === 'connected') {
                    payload.connected = true;
                }

                return node.send(payload);
            }
            case 'sendWS': {
                let shard = this.client.shards.get(message.shardId);
                if (shard === undefined) return;

                const payload = JSON.parse(message.message);

                shard.sendWS(payload.op, payload.d);

                if (payload.op === 4 && payload.d.channel_id === null) {
                    this.delete(payload.d.guild_id);
                }
            }
            case 'playerUpdate': {
                let player = this.get(message.guildId);
                if (!player) return;

                return player.stateUpdate(message.state);
            }
            case 'event': {
                let player = this.get(message.guildId);
                if (!player) return;

                switch (message.type) {
                    case 'TrackEndEvent':
                        return player.onTrackEnd(message);
                    case 'TrackExceptionEvent':
                        return player.onTrackException(message);
                    case 'TrackStuckEvent':
                        return player.onTrackStuck(message);
                    default:
                        return player.emit('warn', `Unexpected event type: ${message.type}`);
                }
            }
        }
    }

    /**
     * Join a voice channel
     * @param {string} guildId The guild ID
     * @param {string} channelId The channel ID
     * @param {Object} options Join options
     * @param {Player} [player] Optionally pass an existing player
     * @returns {Promise<Player>}
     */
    async join(guildId, channelId, options, player) {
        options = options || {};

        player = player || this.get(guildId);
        if (player && player.channelId !== channelId) {
            player.switchChannel(channelId);
            return Promise.resolve(player);
        }

        let region = this.getRegionFromData(options.region || 'us');
        let node = await this.findIdealNode(region);

        if (!node) {
            return Promise.reject('No available voice nodes.');
        }

        return new Promise((res, rej) => {
            this.pendingGuilds[guildId] = {
                channelId: channelId,
                options: options || {},
                player: player || null,
                node: node,
                res: res,
                rej: rej,
                timeout: setTimeout(() => {
                    node.send({ op: 'disconnect', guildId: guildId });
                    delete this.pendingGuilds[guildId];
                    rej(new Error('Voice connection timeout'));
                }, 10000),
            };

            node.send({
                op: 'connect',
                guildId: guildId,
                channelId: channelId,
            });
        });
    }

    /**
     * Leave a voice channel
     * @param {string} guildId The guild ID
     */
    async leave(guildId) {
        let player = this.get(guildId);
        if (!player) {
            return;
        }
        player.disconnect();
        this.delete(player);
    }

    /**
     * Find the ideal voice node based on load and region
     * @param {string} region Guild region
     * @private
     */
    async findIdealNode(region) {
        let nodes = [...this.nodes.values()].filter(node => !node.draining && node.ws && node.connected);

        if (region) {
            let regionalNodes = nodes.filter(node => node.region === region);
            if (regionalNodes && regionalNodes.length) {
                nodes = regionalNodes;
            }
        }

        nodes = nodes.sort((a, b) => {
            let aload = a.stats.cpu ? (a.stats.cpu.systemLoad / a.stats.cpu.cores) * 100 : 0,
                bload = b.stats.cpu ? (b.stats.cpu.systemLoad / b.stats.cpu.cores) * 100 : 0;
            return aload - bload;
        });
        return nodes[0];
    }

    /**
     * Called by eris when a voice server update is received
     * @param {*} data The voice server update from eris
     * @private
     */
    async voiceServerUpdate(data) {
        if (this.pendingGuilds[data.guild_id] && this.pendingGuilds[data.guild_id].timeout) {
            clearTimeout(this.pendingGuilds[data.guild_id].timeout);
            this.pendingGuilds[data.guild_id].timeout = null;
        }

        let player = this.get(data.guild_id);
        if (!player) {
            if (!this.pendingGuilds[data.guild_id]) {
                return;
            }

            player = this.pendingGuilds[data.guild_id].player;

            if (player) {
                player.sessionId = data.sessionId;
                player.hostname = this.pendingGuilds[data.guild_id].hostname;
                player.node = this.pendingGuilds[data.guild_id].node;
                player.event = data;
                this.set(data.guild_id, player);
            }

            player = player || this.add(new this.baseObject(data.guild_id, {
                shard: data.shard,
                guildId: data.guild_id,
                sessionId: data.session_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                hostname: this.pendingGuilds[data.guild_id].hostname,
                node: this.pendingGuilds[data.guild_id].node,
                options: this.pendingGuilds[data.guild_id].options,
                event: data,
                manager: this,
            }));

            player.connect({
                sessionId: data.session_id,
                guildId: data.guild_id,
                channelId: this.pendingGuilds[data.guild_id].channelId,
                event: {
                    endpoint: data.endpoint,
                    guild_id: data.guild_id,
                    token: data.token,
                },
            });
        }

        let disconnectHandler = () => {
            player = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (player) {
                    player.removeListener('ready', readyHandler);
                }
                return;
            }
            player.removeListener('ready', readyHandler);
            this.pendingGuilds[data.guild_id].rej(new Error('Disconnected'));
            delete this.pendingGuilds[data.guild_id];
        };

        let readyHandler = () => {
            player = this.get(data.guild_id);
            if (!this.pendingGuilds[data.guild_id]) {
                if (player) {
                    player.removeListener('disconnect', disconnectHandler);
                }
                return;
            }
            player.removeListener('disconnect', disconnectHandler);
            this.pendingGuilds[data.guild_id].res(player);
            delete this.pendingGuilds[data.guild_id];
        };

        player.once('ready', readyHandler).once('disconnect', disconnectHandler);
    }

    /**
     * Get ideal region from data
     * @param {string} endpoint Endpoint or region
     * @private
     */
    getRegionFromData(endpoint) {
        if (!endpoint) return this.options.defaultRegion || 'us';

        endpoint = endpoint.replace('vip-', '');

        for (let key in this.regions) {
            let nodes = this.nodes.filter(n => n.region === key);
            if (!nodes || !nodes.length) continue;
            if (!nodes.find(n => n.connected && !n.draining)) continue;
            for (let region of this.regions[key]) {
                if (endpoint.startsWith(region)) {
                    return key;
                }
            }
        }

        return this.options.defaultRegion || 'us';
    }
}

module.exports = PlayerManager;
